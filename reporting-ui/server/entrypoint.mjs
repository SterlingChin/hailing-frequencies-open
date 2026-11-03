import { mkdir, chown, chmod } from 'node:fs/promises';
// Railway volumes initially belong to root. Initialize only our storage directory,
// then drop all root groups/privileges before loading the application.
if (process.getuid?.() === 0) {
 if (process.env.EXPERT_DISPATCH_DIR) {
  await mkdir(process.env.EXPERT_DISPATCH_DIR, { recursive: true, mode: 0o700 });
  await chown(process.env.EXPERT_DISPATCH_DIR, 1000, 1000);
  await chmod(process.env.EXPERT_DISPATCH_DIR, 0o700);
 }
 process.initgroups('node', 'node'); process.setgid('node'); process.setuid('node');
}
await import('./index.mjs');
