// A URL slug: lowercase ASCII letters and digits, with each run of anything
// else turned into a single hyphen, and no hyphen at either end.
export function slugify(title: string): string {
  let out = ''
  let dash = false
  for (const ch of title.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      out += ch
      dash = false
    } else if (!dash && out) {
      out += '-'
      dash = true
    }
  }
  return out.endsWith('-') ? out.slice(0, -1) : out
}
