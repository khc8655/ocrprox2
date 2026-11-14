import { PRESET_MAP } from './generated-presets.js';

/**
 * Returns pre-compiled presets map (pure Web Standard, zero node:fs/node:path).
 */
export function getPresetMap() {
  return PRESET_MAP;
}
