/// <reference types="vite/client" />

// SL-0 app tester (docs/app-tester/DESIGN.md): true only in test-bridge builds
// (`PLY_TEST_BRIDGE=1`, vite.config.ts). Everywhere else it is `false` and the
// bundler drops every branch it guards.
declare const __PLY_TEST_BRIDGE__: boolean;
