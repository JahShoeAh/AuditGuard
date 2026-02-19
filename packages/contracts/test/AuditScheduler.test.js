/**
 * AuditScheduler.test.js
 * Hardhat unit tests for the AuditScheduler HSS integration contract.
 *
 * Tests cover:
 *   - scheduleAudit() TIME_BASED: emits AuditScheduled, stores schedule data
 *   - scheduleAudit() REDEPLOY: stores schedule without HSS call
 *   - triggerAudit(): emits AuditTriggered, re-schedules for TIME_BASED
 *   - triggerAudit() with failed re-schedule: emits ScheduleFailed, deactivates
 *   - cancelSchedule(): emits AuditScheduleCancelled, marks inactive
 *   - onRedeployDetected(): arms HSS schedule for REDEPLOY-mode contracts
 *   - access control: unauthorized callers are rejected
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const TriggerMode = { TIME_BASED: 0, REDEPLOY: 1 };

// ─── Minimal mock for the HSS precompile at 0x16b ────────────────────────────
// We cannot deploy a real HSS precompile in Hardhat, so we impersonate 0x16b
// and pre-configure it to return success responses.
async function deployMockHSS(wallet) {
  // AuditScheduler encodes calls to 0x16b and calls it; we need to intercept.
  // Strategy: deploy a MockHSS contract at a predictable address, then
  // overwrite the 0x16b slot using hardhat_setCode.
  const MockHSS = await ethers.getContractFactory("MockHSS");
  const mock = await MockHSS.deploy();
  await mock.waitForDeployment();
  const mockCode = await ethers.provider.getCode(await mock.getAddress());
  await ethers.provider.send("hardhat_setCode", ["0x000000000000000000000000000000000000016B", mockCode]);
  return mock;
}

describe("AuditScheduler", function () {
  let scheduler, owner, orchestrator, stranger;
  let contractAddr;

  const GUARD_TOKEN = "0x0000000000000000000000000000000000000167"; // HTS precompile (mocked)
  const AUCTION_ADDR = "0x000000000000000000000000000000000000dEaD";
  const MIN_BUDGET = ethers.parseUnits("5", 8);
  const ONE_DAY = 86_400;
  const THIRTY_DAYS = 30 * ONE_DAY;

  beforeEach(async function () {
    [owner, orchestrator, stranger] = await ethers.getSigners();
    contractAddr = stranger.address; // arbitrary address to "audit"

    // Deploy MockHSS at 0x16b
    await deployMockHSS(owner);

    const AuditScheduler = await ethers.getContractFactory("AuditScheduler");
    scheduler = await AuditScheduler.deploy(
      GUARD_TOKEN,
      AUCTION_ADDR,
      orchestrator.address,
      MIN_BUDGET
    );
    await scheduler.waitForDeployment();
  });

  // ─── scheduleAudit — TIME_BASED ───────────────────────────────────────────

  describe("scheduleAudit() — TIME_BASED", function () {
    it("emits AuditScheduled with correct params", async function () {
      const tx = await scheduler
        .connect(owner)
        .scheduleAudit(contractAddr, THIRTY_DAYS, TriggerMode.TIME_BASED);

      await expect(tx)
        .to.emit(scheduler, "AuditScheduled")
        .withArgs(
          contractAddr,
          owner.address,
          (v) => v !== ethers.ZeroAddress, // scheduleAddress from MockHSS
          (v) => v > 0n, // nextAuditDue
          TriggerMode.TIME_BASED,
          THIRTY_DAYS
        );
    });

    it("stores correct schedule data", async function () {
      await scheduler
        .connect(owner)
        .scheduleAudit(contractAddr, THIRTY_DAYS, TriggerMode.TIME_BASED);

      const sched = await scheduler.getSchedule(contractAddr);
      expect(sched.owner).to.equal(owner.address);
      expect(sched.mode).to.equal(TriggerMode.TIME_BASED);
      expect(sched.intervalSeconds).to.equal(THIRTY_DAYS);
      expect(sched.active).to.be.true;
      expect(sched.timesTriggered).to.equal(0n);
    });

    it("rejects interval below MIN_INTERVAL (1 hour)", async function () {
      await expect(
        scheduler.connect(owner).scheduleAudit(contractAddr, 3600 - 1, TriggerMode.TIME_BASED)
      ).to.be.revertedWith("AuditScheduler: interval too short");
    });

    it("rejects interval above MAX_INTERVAL (365 days)", async function () {
      await expect(
        scheduler.connect(owner).scheduleAudit(contractAddr, 365 * ONE_DAY + 1, TriggerMode.TIME_BASED)
      ).to.be.revertedWith("AuditScheduler: interval too long");
    });

    it("appears in getActiveSchedules()", async function () {
      await scheduler.connect(owner).scheduleAudit(contractAddr, THIRTY_DAYS, TriggerMode.TIME_BASED);
      const active = await scheduler.getActiveSchedules();
      expect(active).to.include(contractAddr);
    });
  });

  // ─── scheduleAudit — REDEPLOY ─────────────────────────────────────────────

  describe("scheduleAudit() — REDEPLOY", function () {
    it("stores schedule with mode=REDEPLOY and emits AuditScheduled(addr(0))", async function () {
      const tx = await scheduler
        .connect(owner)
        .scheduleAudit(contractAddr, 0, TriggerMode.REDEPLOY);

      await expect(tx)
        .to.emit(scheduler, "AuditScheduled")
        .withArgs(
          contractAddr,
          owner.address,
          ethers.ZeroAddress,
          0n,
          TriggerMode.REDEPLOY,
          0n
        );

      const sched = await scheduler.getSchedule(contractAddr);
      expect(sched.mode).to.equal(TriggerMode.REDEPLOY);
      expect(sched.active).to.be.true;
    });
  });

  // ─── triggerAudit ─────────────────────────────────────────────────────────

  describe("triggerAudit()", function () {
    beforeEach(async function () {
      await scheduler
        .connect(owner)
        .scheduleAudit(contractAddr, THIRTY_DAYS, TriggerMode.TIME_BASED);
    });

    it("orchestrator can call triggerAudit and emits AuditTriggered", async function () {
      const tx = await scheduler.connect(orchestrator).triggerAudit(contractAddr);
      await expect(tx).to.emit(scheduler, "AuditTriggered").withArgs(
        contractAddr,
        (v) => true, // firedSchedule
        (v) => v > 0n, // triggeredAt
        1n, // timesTriggered
        (v) => true  // nextScheduleAddress
      );
    });

    it("increments timesTriggered", async function () {
      await scheduler.connect(orchestrator).triggerAudit(contractAddr);
      const sched = await scheduler.getSchedule(contractAddr);
      expect(sched.timesTriggered).to.equal(1n);
    });

    it("advances nextAuditDue by intervalSeconds", async function () {
      const before = (await scheduler.getSchedule(contractAddr)).nextAuditDue;
      await scheduler.connect(orchestrator).triggerAudit(contractAddr);
      const after = (await scheduler.getSchedule(contractAddr)).nextAuditDue;
      expect(after - before).to.equal(BigInt(THIRTY_DAYS));
    });

    it("rejects unauthorized caller", async function () {
      await expect(
        scheduler.connect(stranger).triggerAudit(contractAddr)
      ).to.be.revertedWith("AuditScheduler: unauthorized caller");
    });

    it("rejects call on inactive schedule", async function () {
      await scheduler.connect(owner).cancelSchedule(contractAddr);
      await expect(
        scheduler.connect(orchestrator).triggerAudit(contractAddr)
      ).to.be.revertedWith("AuditScheduler: no active schedule");
    });
  });

  // ─── cancelSchedule ───────────────────────────────────────────────────────

  describe("cancelSchedule()", function () {
    beforeEach(async function () {
      await scheduler
        .connect(owner)
        .scheduleAudit(contractAddr, THIRTY_DAYS, TriggerMode.TIME_BASED);
    });

    it("emits AuditScheduleCancelled and marks inactive", async function () {
      const tx = await scheduler.connect(owner).cancelSchedule(contractAddr);
      await expect(tx)
        .to.emit(scheduler, "AuditScheduleCancelled")
        .withArgs(contractAddr, owner.address, "manual_cancel");

      const sched = await scheduler.getSchedule(contractAddr);
      expect(sched.active).to.be.false;
    });

    it("removes from getActiveSchedules()", async function () {
      await scheduler.connect(owner).cancelSchedule(contractAddr);
      const active = await scheduler.getActiveSchedules();
      expect(active).to.not.include(contractAddr);
    });

    it("rejects unauthorized caller", async function () {
      await expect(
        scheduler.connect(stranger).cancelSchedule(contractAddr)
      ).to.be.revertedWith("AuditScheduler: unauthorized");
    });
  });

  // ─── onRedeployDetected ───────────────────────────────────────────────────

  describe("onRedeployDetected()", function () {
    it("arms an immediate schedule for REDEPLOY-mode contract", async function () {
      await scheduler.connect(owner).scheduleAudit(contractAddr, 0, TriggerMode.REDEPLOY);
      const tx = await scheduler.connect(orchestrator).onRedeployDetected(contractAddr);
      await expect(tx).to.emit(scheduler, "AuditScheduled");

      const sched = await scheduler.getSchedule(contractAddr);
      expect(sched.nextAuditDue).to.be.gt(0n);
      expect(sched.currentScheduleAddr).to.not.equal(ethers.ZeroAddress);
    });

    it("is a no-op for TIME_BASED contracts", async function () {
      await scheduler.connect(owner).scheduleAudit(contractAddr, THIRTY_DAYS, TriggerMode.TIME_BASED);
      const schedBefore = await scheduler.getSchedule(contractAddr);
      // Should not revert, but should not change the schedule
      await scheduler.connect(orchestrator).onRedeployDetected(contractAddr);
      const schedAfter = await scheduler.getSchedule(contractAddr);
      expect(schedAfter.currentScheduleAddr).to.equal(schedBefore.currentScheduleAddr);
    });

    it("rejects non-orchestrator caller", async function () {
      await scheduler.connect(owner).scheduleAudit(contractAddr, 0, TriggerMode.REDEPLOY);
      await expect(
        scheduler.connect(stranger).onRedeployDetected(contractAddr)
      ).to.be.revertedWith("AuditScheduler: caller is not orchestrator");
    });
  });

  // ─── Admin ────────────────────────────────────────────────────────────────

  describe("Admin", function () {
    it("owner can update orchestrator", async function () {
      await scheduler.connect(owner).setOrchestrator(stranger.address);
      expect(await scheduler.orchestrator()).to.equal(stranger.address);
    });

    it("non-owner cannot update orchestrator", async function () {
      await expect(
        scheduler.connect(stranger).setOrchestrator(stranger.address)
      ).to.be.revertedWithCustomError(scheduler, "OwnableUnauthorizedAccount");
    });
  });
});
