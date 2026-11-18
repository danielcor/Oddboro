// Loaded with `--import` into a process a test starts, such as the tool
// server, so that process runs as if on the system `ODDBORO_TEST_PLATFORM`
// names, the way the office's `onPlatform` fakes it in its own process.
// Imports nothing from src, so it is set before any office code reads it.
const SYSTEMS = ['darwin', 'linux', 'win32'] as const;
const asked = process.env.ODDBORO_TEST_PLATFORM;
const platform = SYSTEMS.find((s) => s === asked);
if (!platform) throw new Error(`ODDBORO_TEST_PLATFORM must be one of ${SYSTEMS.join(', ')}`);
Object.defineProperty(process, 'platform', { value: platform });
