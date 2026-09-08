/** URL helpers for deep-linking into saved queries and dashboards. */

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || "item";
}

export function queryPath(id: number, name?: string): string {
  const slug = name ? slugify(name) : "";
  return slug ? `/workspace/q/${id}/${slug}` : `/workspace/q/${id}`;
}

export function dashboardPath(id: number, name?: string): string {
  const slug = name ? slugify(name) : "";
  return slug ? `/dashboards/${id}/${slug}` : `/dashboards/${id}`;
}

export function absoluteUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
