import request from "supertest";
import { expect } from "chai";
import fs from "fs";
import app from "../server.js";

// Reset DB before each test run
beforeEach(() => {
    fs.writeFileSync("./db.json", JSON.stringify({ tickets: [] }, null, 2));
});

describe("IssueBuddy API Tests", () => {

  let createdId = null;

  it("GET /health → ok:true", async () => {
    const res = await request(app).get("/health");
    expect(res.status).to.equal(200);
    expect(res.body.ok).to.equal(true);
  });

  it("POST /api/tickets → create a ticket", async () => {
    const res = await request(app)
      .post("/api/tickets")
      .send({
        title: "Login bug",
        description: "User cannot login",
        status: "open",
        priority: "high",
        assignee: "Alex"
      });

    expect(res.status).to.equal(201);
    expect(res.body).to.have.property("id");
    createdId = res.body.id;
  });

  it("GET /api/tickets → list tickets", async () => {
    const res = await request(app).get("/api/tickets");
    expect(res.status).to.equal(200);
    expect(res.body).to.have.property("data");
    expect(res.body.data.length).to.be.greaterThan(0);
  });

  it("GET /api/tickets/:id → fetch by id", async () => {
    const res = await request(app).get(`/api/tickets/${createdId}`);
    expect(res.status).to.equal(200);
    expect(res.body.id).to.equal(createdId);
  });

  it("PUT /api/tickets/:id → full update", async () => {
    const res = await request(app)
      .put(`/api/tickets/${createdId}`)
      .send({
        title: "Updated bug title",
        description: "Updated description",
        status: "in_progress",
        priority: "medium",
        assignee: "Sam"
      });

    expect(res.status).to.equal(200);
    expect(res.body.title).to.equal("Updated bug title");
  });

  it("PATCH /api/tickets/:id → partial update", async () => {
    const res = await request(app)
      .patch(`/api/tickets/${createdId}`)
      .send({ priority: "urgent" });

    expect(res.status).to.equal(200);
    expect(res.body.priority).to.equal("urgent");
  });

  it("DELETE /api/tickets/:id → delete ticket", async () => {
    const res = await request(app).delete(`/api/tickets/${createdId}`);
    expect(res.status).to.equal(204);
  });

  it("GET deleted item → 404", async () => {
    const res = await request(app).get(`/api/tickets/${createdId}`);
    expect(res.status).to.equal(404);
  });

});
4. CI Pipeline Integration

I integrated the test suite into a Continuous Integration (CI) pipeline (GitHub Actions).
The pipeline performs the following steps automatically on every push or pull request:

Checkout the repository

Install dependencies (npm install)

Run the test suite (npm test)

Fail the pipeline if any test case fails

This ensures:

No broken code is merged

API behaviour remains consistent

Bugs are caught early

5. Result

By implementing unit and integration tests and automating them through CI, I achieved:

Higher API reliability

Independent test execution

Early detection of issues

Continuous validation of backend functionality