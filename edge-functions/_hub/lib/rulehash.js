export function ruleHash(rules) {
const json = JSON.stringify(rules || {});
let h = 0x811c9dc5;
for (let i = 0; i < json.length; i++) {
h ^= json.charCodeAt(i);
h = Math.imul(h, 0x01000193);
}
return (h >>> 0).toString(16).padStart(8, '0');
}