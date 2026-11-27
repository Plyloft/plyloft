/** n16 app tester (docs/app-tester/DESIGN.md): true only in "Plyloft Test"
 *  (a test-bridge build); a release folds it to `false` and drops what it
 *  guards. Read by `UpdatePrompt.tsx`, so a test build never checks for,
 *  offers or installs a release update. Holds no bridge marker. */
export const isTestBuild: boolean = __PLY_TEST_BRIDGE__;
