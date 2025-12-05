import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import { Low, JSONFile } from 'lowdb';
import { nanoid } from 'nanoid';
import { 
  hashPassword, 
  comparePasswords, 
  generateToken, 
  verifyToken, 
  authMiddleware, 
  validateEmail, 
  validatePassword 
} from './auth.js';
import { 
  sendEmail, 
  mentionEmailTemplate, 
  assignmentEmailTemplate, 
  overdueEmailTemplate 
} from './email.js';

const PORT = process.env.PORT || 8080;
const allowList = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()),
    methods: ['GET', 'POST']
  }
});
app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowList.includes('*') || allowList.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  }
}));

// test DB vs real DB
const isTest = process.env.NODE_ENV === "test";
const dbFile = isTest ? "./db.test.json" : "./db.json";

// Initialize lowdb with JSONFile adapter
const adapter = new JSONFile(dbFile);
const db = new Low(adapter);
await db.read();
const defaultData = { tickets: [], comments: [], history: [], savedFilters: [], users: [] };
if (!db.data) {
  db.data = defaultData;
  await db.write();
}

// Real-time activity tracking
const onlineUsers = new Map();
const userConnections = new Map();

function validate(payload, { partial=false } = {}) {
  const allowedStatus = ['open','in_progress','review','closed'];
  const allowedPriority = ['low','medium','high','urgent'];
  const e = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);

  if (!partial || has('title')) {
    if (typeof payload.title !== 'string' || payload.title.trim().length < 3) 
      e.push('title must be at least 3 chars');
    else if (payload.title.trim().length > 100) 
      e.push('title must be at most 100 chars');
  }
  if (!partial || has('description')) {
    if (typeof payload.description !== 'string' || payload.description.trim().length < 3) 
      e.push('description must be at least 3 chars');
    else if (payload.description.trim().length > 1000) 
      e.push('description must be at most 1000 chars');
  }
  if (!partial || has('status')) {
    if (!allowedStatus.includes(payload.status)) e.push('status must be one of ' + allowedStatus.join(', '));
  }
  if (!partial || has('priority')) {
    if (!allowedPriority.includes(payload.priority)) e.push('priority must be one of ' + allowedPriority.join(', '));
  }
  if (has('assignee') && payload.assignee && typeof payload.assignee === 'string' && payload.assignee.trim().length > 50) {
    e.push('assignee must be at most 50 chars');
  }
  if (has('relatedTickets') && payload.relatedTickets && !Array.isArray(payload.relatedTickets)) {
    e.push('relatedTickets must be an array');
  }
  return e;
}

app.get('/health', (_req,res)=>res.json({ ok:true }));

// ===== AUTH ENDPOINTS =====
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name } = req.body;

  if (!validateEmail(email)) {
    return res.status(400).json({ errors: ['Invalid email format'] });
  }

  if (!validatePassword(password)) {
    return res.status(400).json({ errors: ['Password must be at least 6 characters'] });
  }

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ errors: ['Name must be at least 2 characters'] });
  }

  const existingUser = db.data.users.find(u => u.email === email);
  if (existingUser) {
    return res.status(409).json({ errors: ['Email already registered'] });
  }

  const hashedPassword = await hashPassword(password);
  const user = {
    id: nanoid(),
    email,
    password: hashedPassword,
    name: name.trim(),
    avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random`,
    role: 'user',
    createdAt: new Date().toISOString()
  };

  db.data.users.push(user);
  await db.write();

  const token = generateToken(user.id, user.email);
  res.status(201).json({
    token,
    user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar, role: user.role }
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ errors: ['Email and password required'] });
  }

  const user = db.data.users.find(u => u.email === email);
  if (!user) {
    return res.status(401).json({ errors: ['Invalid credentials'] });
  }

  const passwordMatch = await comparePasswords(password, user.password);
  if (!passwordMatch) {
    return res.status(401).json({ errors: ['Invalid credentials'] });
  }

  const token = generateToken(user.id, user.email);
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar, role: user.role }
  });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.data.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    role: user.role
  });
});

app.get('/api/users', (req, res) => {
  const users = db.data.users.map(u => ({
    id: u.id,
    email: u.email,
    name: u.name,
    avatar: u.avatar,
    role: u.role,
    isOnline: onlineUsers.has(u.id)
  }));
  res.json(users);
});

app.get('/api/auth/verify', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ valid: false });

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const payload = verifyToken(token);
  
  if (!payload) return res.status(401).json({ valid: false });

  const user = db.data.users.find(u => u.id === payload.userId);
  if (!user) return res.status(401).json({ valid: false });

  res.json({
    valid: true,
    user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar }
  });
});

// ===== WEBSOCKET EVENTS =====
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('user:login', (userId) => {
    onlineUsers.set(userId, { socketId: socket.id, loginTime: Date.now() });
    userConnections.set(socket.id, userId);
    io.emit('presence:update', {
      userId,
      isOnline: true,
      user: db.data.users.find(u => u.id === userId)
    });
  });

  socket.on('ticket:created', (ticket) => {
    io.emit('ticket:created', ticket);
  });

  socket.on('ticket:updated', (ticket) => {
    io.emit('ticket:updated', ticket);
  });

  socket.on('ticket:deleted', (ticketId) => {
    io.emit('ticket:deleted', ticketId);
  });

  socket.on('comment:added', (comment) => {
    io.emit('comment:added', comment);
  });

  socket.on('activity:log', (activity) => {
    io.emit('activity:log', activity);
  });

  socket.on('disconnect', () => {
    const userId = userConnections.get(socket.id);
    if (userId) {
      onlineUsers.delete(userId);
      userConnections.delete(socket.id);
      io.emit('presence:update', { userId, isOnline: false });
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

app.get('/api/tickets', (req,res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const status = String(req.query.status ?? '');
  const priority = String(req.query.priority ?? '');
  const assignee = String(req.query.assignee ?? '').trim().toLowerCase();
  const tags = String(req.query.tags ?? '').split(',').map(t => t.trim()).filter(Boolean);
  const sortBy = String(req.query.sortBy ?? 'updatedAt');
  const sortOrder = String(req.query.sortOrder ?? 'desc');
  const fromDate = req.query.fromDate ? new Date(req.query.fromDate) : null;
  const toDate = req.query.toDate ? new Date(req.query.toDate) : null;
  const overdue = String(req.query.overdue ?? '') === 'true';
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'),10));
  const pageSize = Math.max(1, Math.min(100, parseInt(String(req.query.pageSize ?? '10'),10)));
  const offset = (page-1)*pageSize;

  let items = db.data.tickets;
  if (q) items = items.filter(t => t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
  if (['open','in_progress','closed','review'].includes(status)) items = items.filter(t => t.status === status);
  if (['low','medium','high','urgent'].includes(priority)) items = items.filter(t => t.priority === priority);
  if (assignee) items = items.filter(t => (t.assignee || '').toLowerCase().includes(assignee));
  if (tags.length > 0) items = items.filter(t => tags.some(tag => (t.tags || []).includes(tag)));
  if (fromDate) items = items.filter(t => new Date(t.createdAt) >= fromDate);
  if (toDate) items = items.filter(t => new Date(t.createdAt) <= toDate);
  if (overdue) {
    const now = new Date();
    items = items.filter(t => t.dueDate && new Date(t.dueDate) < now && t.status !== 'closed');
  }

  // Sorting
  items = items.sort((a,b) => {
    let aVal = a[sortBy];
    let bVal = b[sortBy];
    if (sortBy === 'createdAt' || sortBy === 'updatedAt' || sortBy === 'dueDate') {
      aVal = new Date(aVal || 0);
      bVal = new Date(bVal || 0);
    }
    if (sortOrder === 'asc') {
      return aVal > bVal ? 1 : -1;
    }
    return aVal < bVal ? 1 : -1;
  });

  const total = items.length;
  const data = items.slice(offset, offset+pageSize);
  res.json({ total, page, pageSize, data });
});

app.get('/api/tickets/:id', (req,res) => {
  const t = db.data.tickets.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error:'not_found' });
  res.json(t);
});

function addHistory(ticketId, action, changes, user = 'System') {
  const entry = {
    id: nanoid(),
    ticketId,
    action,
    changes,
    user,
    timestamp: new Date().toISOString()
  };
  db.data.history.unshift(entry);
  return entry;
}

app.post('/api/tickets', async (req,res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ errors });
  const now = new Date().toISOString();
  const item = {
    id: nanoid(),
    title: req.body.title.trim(),
    description: req.body.description.trim(),
    status: req.body.status,
    priority: req.body.priority,
    assignee: req.body.assignee ?? '',
    dueDate: req.body.dueDate || null,
    tags: req.body.tags || [],
    createdAt: now, updatedAt: now
  };
  db.data.tickets.unshift(item);
  addHistory(item.id, 'created', { ticket: item }, req.body.user || 'Anonymous');
  await db.write();
  
  // Emit WebSocket event
  io.emit('ticket:created', { ticket: item, user: req.body.user });
  
  res.status(201).json(item);
});

app.put('/api/tickets/:id', async (req,res) => {
  const idx = db.data.tickets.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error:'not_found' });
  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ errors });

  const old = db.data.tickets[idx];
  const now = new Date().toISOString();
  const updated = {
    ...old,
    title: req.body.title.trim(),
    description: req.body.description.trim(),
    status: req.body.status,
    priority: req.body.priority,
    assignee: req.body.assignee ?? '',
    dueDate: req.body.dueDate || null,
    tags: req.body.tags || [],
    updatedAt: now
  };
  const changes = {};
  if (old.title !== updated.title) changes.title = { from: old.title, to: updated.title };
  if (old.description !== updated.description) changes.description = { from: old.description, to: updated.description };
  if (old.status !== updated.status) changes.status = { from: old.status, to: updated.status };
  if (old.priority !== updated.priority) changes.priority = { from: old.priority, to: updated.priority };
  if (old.assignee !== updated.assignee) changes.assignee = { from: old.assignee, to: updated.assignee };
  if (old.dueDate !== updated.dueDate) changes.dueDate = { from: old.dueDate, to: updated.dueDate };
  if (Object.keys(changes).length > 0) {
    addHistory(req.params.id, 'updated', changes, req.body.user || 'Anonymous');
  }
  db.data.tickets[idx] = updated;
  await db.write();
  
  // Emit WebSocket event
  io.emit('ticket:updated', { ticket: updated, changes, user: req.body.user });
  
  // Send email notification if assignee changed
  if (old.assignee !== updated.assignee && updated.assignee) {
    const assignee = db.data.users.find(u => u.email === updated.assignee || u.id === updated.assignee);
    if (assignee) {
      const user = db.data.users.find(u => u.id === req.body.userId);
      await sendEmail(assignee.email, `Assigned: ${updated.title}`, 
        assignmentEmailTemplate(user?.name || 'Someone', updated, assignee.name));
    }
  }
  
  res.json(updated);
});

app.patch('/api/tickets/:id', async (req,res) => {
  const idx = db.data.tickets.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error:'not_found' });
  const errors = validate(req.body, { partial:true });
  if (errors.length) return res.status(400).json({ errors });

  const old = db.data.tickets[idx];
  const now = new Date().toISOString();
  const updated = { ...old, ...req.body, updatedAt: now };
  if (updated.title) updated.title = String(updated.title).trim();
  if (updated.description) updated.description = String(updated.description).trim();
  const changes = {};
  Object.keys(req.body).forEach(key => {
    if (key !== 'user' && old[key] !== updated[key]) {
      changes[key] = { from: old[key], to: updated[key] };
    }
  });
  if (Object.keys(changes).length > 0) {
    addHistory(req.params.id, 'updated', changes, req.body.user || 'Anonymous');
  }
  db.data.tickets[idx] = updated;
  await db.write();
  res.json(updated);
});

app.delete('/api/tickets/:id', async (req,res) => {
  const ticket = db.data.tickets.find(x => x.id === req.params.id);
  if (!ticket) return res.status(404).json({ error:'not_found' });
  addHistory(req.params.id, 'deleted', { ticket }, req.query.user || 'Anonymous');
  db.data.tickets = db.data.tickets.filter(x => x.id !== req.params.id);
  db.data.comments = db.data.comments.filter(c => c.ticketId !== req.params.id);
  await db.write();
  
  // Emit WebSocket event
  io.emit('ticket:deleted', { ticketId: req.params.id, user: req.query.user });
  
  res.status(204).send();
});

// History endpoint
app.get('/api/tickets/:ticketId/history', (req,res) => {
  const history = db.data.history
    .filter(h => h.ticketId === req.params.ticketId)
    .sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(history);
});

// Comments endpoints
app.get('/api/tickets/:ticketId/comments', (req,res) => {
  const comments = db.data.comments
    .filter(c => c.ticketId === req.params.ticketId)
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(comments);
});

app.post('/api/tickets/:ticketId/comments', async (req,res) => {
  const ticket = db.data.tickets.find(t => t.id === req.params.ticketId);
  if (!ticket) return res.status(404).json({ error:'ticket_not_found' });
  
  if (!req.body.text || typeof req.body.text !== 'string' || req.body.text.trim().length < 1) {
    return res.status(400).json({ errors: ['comment text is required'] });
  }
  if (req.body.text.trim().length > 500) {
    return res.status(400).json({ errors: ['comment text must be at most 500 chars'] });
  }

  const now = new Date().toISOString();
  const comment = {
    id: nanoid(),
    ticketId: req.params.ticketId,
    text: req.body.text.trim(),
    author: req.body.author || 'Anonymous',
    authorId: req.body.authorId || '',
    createdAt: now
  };
  
  db.data.comments.unshift(comment);
  await db.write();
  
  // Emit WebSocket event
  io.emit('comment:added', { comment, ticket });
  
  // Check for mentions (@username) and send email notifications
  const mentions = comment.text.match(/@(\w+)/g);
  if (mentions) {
    for (const mention of mentions) {
      const mentionedName = mention.slice(1);
      const mentionedUser = db.data.users.find(u => u.name.toLowerCase() === mentionedName.toLowerCase());
      if (mentionedUser) {
        const author = db.data.users.find(u => u.id === req.body.authorId);
        await sendEmail(mentionedUser.email, `Mentioned in ${ticket.title}`,
          mentionEmailTemplate(author?.name || 'Someone', ticket, comment.text));
      }
    }
  }
  
  res.status(201).json(comment);
});

app.delete('/api/comments/:id', async (req,res) => {
  const before = db.data.comments.length;
  db.data.comments = db.data.comments.filter(c => c.id !== req.params.id);
  if (db.data.comments.length === before) return res.status(404).json({ error:'not_found' });
  await db.write();
  res.status(204).send();
});

// Bulk operations
app.post('/api/tickets/bulk', async (req,res) => {
  const { operation, ids, updates } = req.body;
  if (!operation || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ errors: ['operation and ids array required'] });
  }

  const results = { success: [], failed: [] };
  const now = new Date().toISOString();

  if (operation === 'delete') {
    ids.forEach(id => {
      const ticket = db.data.tickets.find(t => t.id === id);
      if (ticket) {
        addHistory(id, 'deleted', { ticket }, req.body.user || 'Bulk Operation');
        db.data.tickets = db.data.tickets.filter(t => t.id !== id);
        db.data.comments = db.data.comments.filter(c => c.ticketId !== id);
        results.success.push(id);
      } else {
        results.failed.push(id);
      }
    });
  } else if (operation === 'update' && updates) {
    ids.forEach(id => {
      const idx = db.data.tickets.findIndex(t => t.id === id);
      if (idx !== -1) {
        const old = db.data.tickets[idx];
        const updated = { ...old, ...updates, updatedAt: now };
        const changes = {};
        Object.keys(updates).forEach(key => {
          if (old[key] !== updated[key]) {
            changes[key] = { from: old[key], to: updated[key] };
          }
        });
        if (Object.keys(changes).length > 0) {
          addHistory(id, 'bulk_updated', changes, req.body.user || 'Bulk Operation');
        }
        db.data.tickets[idx] = updated;
        results.success.push(id);
      } else {
        results.failed.push(id);
      }
    });
  } else {
    return res.status(400).json({ errors: ['invalid operation'] });
  }

  await db.write();
  res.json(results);
});

// Ticket linking/dependencies
app.post('/api/tickets/:id/link', async (req,res) => {
  const ticket = db.data.tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  
  const { relatedId, relationship } = req.body;
  if (!relatedId) return res.status(400).json({ errors: ['Related ticket ID required'] });
  
  const relatedTicket = db.data.tickets.find(t => t.id === relatedId);
  if (!relatedTicket) return res.status(404).json({ errors: ['Related ticket not found'] });
  
  // Initialize relatedTickets array if not exists
  if (!ticket.relatedTickets) ticket.relatedTickets = [];
  if (!relatedTicket.relatedTickets) relatedTicket.relatedTickets = [];
  
  // Add bidirectional link
  const linkType = relationship || 'related';
  const reverseLinkType = linkType === 'blocks' ? 'blocked_by' : (linkType === 'blocked_by' ? 'blocks' : 'related');
  
  const link = { id: relatedId, type: linkType };
  const reverseLink = { id: ticket.id, type: reverseLinkType };
  
  // Avoid duplicates
  if (!ticket.relatedTickets.find(r => r.id === relatedId)) {
    ticket.relatedTickets.push(link);
    ticket.updatedAt = new Date().toISOString();
    addHistory(ticket.id, 'updated', { relatedTickets: { from: [], to: ticket.relatedTickets } }, req.body.user || 'System');
  }
  if (!relatedTicket.relatedTickets.find(r => r.id === ticket.id)) {
    relatedTicket.relatedTickets.push(reverseLink);
    relatedTicket.updatedAt = new Date().toISOString();
  }
  
  await db.write();
  res.json(ticket);
});

app.delete('/api/tickets/:id/link/:relatedId', async (req,res) => {
  const ticket = db.data.tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  
  const relatedId = req.params.relatedId;
  const relatedTicket = db.data.tickets.find(t => t.id === relatedId);
  
  const oldLinks = ticket.relatedTickets ? [...ticket.relatedTickets] : [];
  
  if (ticket.relatedTickets) {
    ticket.relatedTickets = ticket.relatedTickets.filter(r => r.id !== relatedId);
    ticket.updatedAt = new Date().toISOString();
    addHistory(ticket.id, 'updated', { relatedTickets: { from: oldLinks, to: ticket.relatedTickets } }, req.query.user || 'System');
  }
  
  if (relatedTicket && relatedTicket.relatedTickets) {
    relatedTicket.relatedTickets = relatedTicket.relatedTickets.filter(r => r.id !== ticket.id);
    relatedTicket.updatedAt = new Date().toISOString();
  }
  
  await db.write();
  res.json(ticket);
});

// Saved Filters
app.get('/api/filters', (req,res) => {
  res.json(db.data.savedFilters || []);
});

app.post('/api/filters', async (req,res) => {
  if (!db.data.savedFilters) db.data.savedFilters = [];
  
  const { name, filters } = req.body;
  if (!name || !filters) {
    return res.status(400).json({ errors: ['Name and filters required'] });
  }
  
  const newFilter = {
    id: nanoid(),
    name: name.trim(),
    filters,
    createdAt: new Date().toISOString()
  };
  
  db.data.savedFilters.push(newFilter);
  await db.write();
  res.status(201).json(newFilter);
});

app.delete('/api/filters/:id', async (req,res) => {
  if (!db.data.savedFilters) db.data.savedFilters = [];
  
  const id = req.params.id;
  const idx = db.data.savedFilters.findIndex(f => f.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Filter not found' });
  
  db.data.savedFilters.splice(idx, 1);
  await db.write();
  res.status(204).send();
});

// Analytics/Dashboard data
app.get('/api/analytics', (req,res) => {
  const tickets = db.data.tickets;
  const now = new Date();
  
  const byStatus = {
    open: tickets.filter(t => t.status === 'open').length,
    in_progress: tickets.filter(t => t.status === 'in_progress').length,
    review: tickets.filter(t => t.status === 'review').length,
    closed: tickets.filter(t => t.status === 'closed').length
  };
  
  const byPriority = {
    low: tickets.filter(t => t.priority === 'low').length,
    medium: tickets.filter(t => t.priority === 'medium').length,
    high: tickets.filter(t => t.priority === 'high').length,
    urgent: tickets.filter(t => t.priority === 'urgent').length
  };
  
  const overdue = tickets.filter(t => t.dueDate && new Date(t.dueDate) < now && t.status !== 'closed').length;
  
  const recentActivity = db.data.history
    .sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 10);
  
  const assigneeStats = {};
  tickets.forEach(t => {
    const assignee = t.assignee || 'Unassigned';
    if (!assigneeStats[assignee]) {
      assigneeStats[assignee] = { total: 0, open: 0, closed: 0 };
    }
    assigneeStats[assignee].total++;
    if (t.status === 'closed') assigneeStats[assignee].closed++;
    else assigneeStats[assignee].open++;
  });
  
  res.json({
    total: tickets.length,
    byStatus,
    byPriority,
    overdue,
    recentActivity,
    assigneeStats
  });
});

if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, () =>
    console.log(`IssueFlow API with WebSocket listening on http://localhost:${PORT}`)
  );
}

export default app;
