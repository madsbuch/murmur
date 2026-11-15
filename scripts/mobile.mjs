import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [platform, ...args] = process.argv.slice(2);
if (!['android', 'ios'].includes(platform)) throw new Error('Use android or ios.');
const env = { ...process.env };
if (platform === 'android') {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(homedir(), 'Library/Android/sdk'), join(homedir(), 'Android/Sdk')];
  env.ANDROID_HOME = candidates.find(p => p && existsSync(p));
  if (!env.ANDROID_HOME) throw new Error('Install the Android SDK and set ANDROID_HOME.');
  if (!env.JAVA_HOME && existsSync('/Applications/Android Studio.app/Contents/jbr/Contents/Home')) {
    env.JAVA_HOME = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
  }
  const ndks = join(env.ANDROID_HOME, 'ndk');
  if (!env.NDK_HOME && existsSync(ndks)) {
    const version = readdirSync(ndks).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    if (version) env.NDK_HOME = join(ndks, version);
  }
}
// Invoke through npm so Tauri generates valid npm callbacks for Gradle/Xcode.
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'tauri', '--', platform, ...args], { cwd: root, env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
