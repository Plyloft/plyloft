// Imported first by every *.test.mjs here, before lib.mjs reads its values:
// the tests' sample accounts (the ones their fixtures and fake-mcp.mjs name),
// set in the environment so this computer's walk.env is never what a test
// sees. Children the tests start inherit them.
process.env.PLY_WALK_ENV = "/nonexistent/walk.env";
process.env.PLY_WALK_OWNER_LOGIN = "test-owner";
process.env.PLY_WALK_MEMBER_LOGIN = "test-user";
process.env.PLY_WALK_SANDBOX_REPO = "test-owner/plyloft-ci-sandbox";
process.env.PLY_WALK_TEAM_REPO = "test-owner/plyloft-test-team";
