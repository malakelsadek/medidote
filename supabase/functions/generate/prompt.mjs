// Prints the question-writing prompt for testing in claude.ai: attach your slides, paste this, save the reply as a .json file, import it in the app.
// Usage (from the project folder):   node supabase/functions/generate/prompt.mjs 30          (30 questions; leave out the number for "as many as needed")
//                                    node supabase/functions/generate/prompt.mjs 30 | clip   (copies it on Windows)
//                                    node supabase/functions/generate/prompt.mjs ai           (the system prompt the AI function itself uses)
import { readFileSync } from "node:fs";
import { buildSystem, manualPrompt } from "./guide.ts";

const guide = JSON.parse(readFileSync(new URL("./guide.json", import.meta.url), "utf8"));
if (process.argv[2] === "ai") process.stdout.write(buildSystem(guide));   // exactly what the AI function sends as its system prompt
else process.stdout.write(manualPrompt(guide, Math.max(0, Math.floor(Number(process.argv[2])) || 0)));
