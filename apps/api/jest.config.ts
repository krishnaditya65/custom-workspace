import type { Config } from 'jest';

/**
 * Unit test config. Runs *.spec.ts files colocated under src/, mocking out
 * Prisma/Redis/etc so these tests never need a live database. See
 * test/jest-e2e.json for the config that hits real infra.
 */
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  // pnpm workspace packages are symlinked into node_modules, so Jest's
  // default transformIgnorePatterns (which skips node_modules) would try
  // to `require` their raw TS source untranspiled. Map them straight to
  // their source entrypoints so ts-jest compiles them like any local file.
  moduleNameMapper: {
    '^@workspace/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@workspace/db$': '<rootDir>/../../packages/db/generated/client/index.js',
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
};

export default config;
