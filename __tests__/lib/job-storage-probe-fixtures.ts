import { beforeAll, afterAll } from 'vitest';
import {
  applyJobStorageDdl,
  createTestDbShim,
  createTestPgDbEmpty,
  drainJobStorageDb,
  truncateJobStorageTables,
  type TestDbHandle,
} from './job-storage-core-fixtures';

let sharedHandle: TestDbHandle;

beforeAll(async () => {
  sharedHandle = await createTestPgDbEmpty();
  await applyJobStorageDdl(sharedHandle);
});

afterAll(async () => {
  await drainJobStorageDb(sharedHandle);
  try {
    await sharedHandle[Symbol.asyncDispose]();
  } catch {
    // ignore
  }
});

export async function truncateAll(): Promise<void> {
  await truncateJobStorageTables(sharedHandle);
}

export const testDb = createTestDbShim(() => sharedHandle);

export function getSharedHandle(): TestDbHandle {
  return sharedHandle;
}

export function makeMissingProcessError(): NodeJS.ErrnoException {
  const error = new Error('ESRCH') as NodeJS.ErrnoException;
  error.code = 'ESRCH';
  return error;
}
