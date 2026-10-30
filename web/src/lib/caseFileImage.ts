import type { RecapNote } from "../types";

const WIDTH = 720;
const LINE = 24;

/** What a shared image may say: at most four notes, and none naming a session unless asked. */
export function exportNotes(notes: RecapNote[], includeNames: boolean): RecapNote[] {
  return notes.filter(note => includeNames || !note.identifying).slice(0, 4);
}

/** The text an export carries, top to bottom. Every number comes from the server's notes. */
export function caseFileLines(input: { label: string; notes: RecapNote[]; demo: boolean }): string[] {
  return [
    ...(input.demo ? ["Demo / synthetic data"] : []),
    "Case file recap",
    input.label,
    ...input.notes.map(note => note.text),
    ...(input.notes.some(note => note.money) ? ["Dollar figures are API list-price equivalents, not bills."] : []),
  ];
}

function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  return line ? [...lines, line] : lines;
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  const image = new Image();
  image.src = url;
  return image.decode().then(() => image, () => null);
}

/** Draws the card on a canvas and downloads it. Only runs on a click. With Hide artwork, `art` is null and no Yaldi is drawn. */
export async function downloadCaseFile(input: { label: string; notes: RecapNote[]; demo: boolean; art: string | null }): Promise<void> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return;
  const art = input.art ? await loadImage(input.art) : null;
  const left = art ? 136 : 28;
  context.font = "15px sans-serif";
  const body = caseFileLines(input).flatMap(line => wrap(context, line, WIDTH - left - 28));
  canvas.width = WIDTH;
  canvas.height = Math.max(160, 56 + body.length * LINE);
  context.fillStyle = "#fbf6eb";
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (art) context.drawImage(art, 20, 28, 100, 100);
  context.fillStyle = "#1f1b16";
  context.font = "15px sans-serif";
  body.forEach((line, index) => context.fillText(line, left, 40 + index * LINE));
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = "yald-case-file.png";
  link.click();
}
