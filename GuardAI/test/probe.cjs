// Ad-hoc probe: print findings + masked output for one message.
const { loadWindow, maskText } = require("./_env.cjs");
(async () => {
  const w = loadWindow();
  const text = process.argv[2] || "";
  const { findings, masked } = await maskText(w, text);
  for (const f of findings) console.log(`${f.type}@${f.index} ${JSON.stringify(f.value)}`);
  console.log("MASKED:", masked);
})();
