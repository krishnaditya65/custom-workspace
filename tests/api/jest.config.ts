const config = {
  rootDir: "../../apps/api",
  roots: ["<rootDir>/../../tests/api"],
  moduleDirectories: ["node_modules", "<rootDir>/node_modules"],
  testEnvironment: "node",
  moduleFileExtensions: ["js", "json", "ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json", isolatedModules: true }],
  },
  moduleNameMapper: {
    "^@workspace/shared$": "<rootDir>/../../packages/shared/src/index.ts",
    "^@workspace/db$": "<rootDir>/../../packages/db/generated/client/index.js",
  },
};

export default config;
