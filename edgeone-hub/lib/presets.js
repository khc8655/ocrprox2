import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let cachedPresets = null;

export function getPresetMap() {
  if (cachedPresets) return cachedPresets;

  const map = {};
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const sharedPresetsDir = join(__dirname, '../../shared/presets');
    if (existsSync(sharedPresetsDir)) {
      const files = readdirSync(sharedPresetsDir).filter((f) => f.endsWith('.json') && f !== 'catalog.json');
      for (const f of files) {
        try {
          const content = JSON.parse(readFileSync(join(sharedPresetsDir, f), 'utf8'));
          if (content && content.id) {
            map[content.id] = content;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  cachedPresets = map;
  return map;
}
