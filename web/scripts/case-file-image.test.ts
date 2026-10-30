import { expect, test } from "bun:test";
import { caseFileLines, exportNotes } from "../src/lib/caseFileImage";

const notes = [
  { text: "Of 9 sessions, 50% were short.", n: 9 },
  { text: "At most 3 at once.", n: 9 },
  { text: "4 of 7 days had data.", n: 7 },
  { text: "10% at night.", n: 90 },
  { text: "The largest session, abc12345, cost $1.00.", n: 5, identifying: true, money: true },
];

test("a shared image hides session ids unless asked, and never exceeds four facts", () => {
  expect(exportNotes(notes, false).some(note => note.text.includes("abc12345"))).toBe(false);
  expect(exportNotes(notes, false)).toHaveLength(4);
  expect(exportNotes(notes.slice(1), true).map(note => note.n)).toContain(5);
});

test("money carries the list-price note and demo data always says so", () => {
  const money = caseFileLines({ label: "w", notes: notes.slice(1), demo: true });
  expect(money[0]).toBe("Demo / synthetic data");
  expect(money.at(-1)).toContain("list-price");
  expect(caseFileLines({ label: "w", notes: notes.slice(0, 1), demo: false }).join(" ")).not.toContain("list-price");
  expect(caseFileLines({ label: "w", notes: notes.slice(0, 1), demo: false })[0]).toBe("Case file recap");
});
