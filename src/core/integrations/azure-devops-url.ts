/**
 * Azure DevOps addresses, shared by the server and the browser app, so it imports nothing.
 * Azure DevOps Services lives at https://dev.azure.com/<organization>/; its older addresses,
 * https://<organization>.visualstudio.com/, still open the same pages. Azure DevOps Server lives
 * at https://<host>/<collection>/, where the collection path can carry a virtual directory
 * (`tfs/DefaultCollection`).
 */
export const SERVICES_HOST = "dev.azure.com";
/** Services organization names: letters, digits and hyphens, starting and ending with a letter or digit. */
export const ORGANIZATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;
const SEGMENT = "[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?";
/** A Server collection path: one segment, or a virtual directory and the collection. */
export const COLLECTION = new RegExp(`^${SEGMENT}(?:/${SEGMENT})?$`);
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** A Server host: a lower-case DNS name with an optional port. Never a path, a scheme or credentials. */
export const SERVER_HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::[0-9]{1,5})?$`);
const LEGACY = /^([a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)\.visualstudio\.com$/i;

/** Where a connection reads: its host and its organization (Services) or collection path (Server). */
export interface AzureDevOpsPlace { host: string; organization: string }

export const isServices = (host: string): boolean => host.toLowerCase() === SERVICES_HOST;

/** Why a host and organization or collection cannot form a connection; null when they can. */
export function placeProblem(place: AzureDevOpsPlace): string | null {
  const host = place.host.toLowerCase();
  if (isServices(host)) return ORGANIZATION.test(place.organization) ? null : "Use the organization name from dev.azure.com/<organization>: letters, numbers and hyphens.";
  if (!SERVER_HOST.test(host) || LEGACY.test(host.replace(/:[0-9]+$/, ""))) return "Use the Azure DevOps Server host name, like tfs.example.com, without https:// or a path.";
  return COLLECTION.test(place.organization) ? null : "Use the collection name, like DefaultCollection, or its path, like tfs/DefaultCollection.";
}

/**
 * A legacy https://<organization>.visualstudio.com/[DefaultCollection/]... address rewritten to the
 * dev.azure.com address of the same page; null when the input is not one.
 */
export function canonicalAzureDevOpsUrl(input: string): string | null {
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  const legacy = LEGACY.exec(url.hostname);
  if (url.protocol !== "https:" || !legacy || url.port || url.username || url.password) return null;
  const rest = url.pathname.replace(/^\/DefaultCollection(?=\/|$)/i, "") || "/";
  return `https://${SERVICES_HOST}/${legacy[1]!.toLowerCase()}${rest}${url.search}${url.hash}`;
}

/** The address of a place's root, ending without a slash: https://<host>/<organization or collection>. */
export function placeUrl(place: AzureDevOpsPlace): string {
  return `https://${place.host.toLowerCase()}/${place.organization.split("/").map(encodeURIComponent).join("/")}`;
}

/** Whether an address (legacy ones included) lies in a connection's organization or collection. */
export function servesUrl(place: AzureDevOpsPlace, input: string): boolean {
  let url: URL;
  try { url = new URL(canonicalAzureDevOpsUrl(input) ?? input); } catch { return false; }
  if (url.protocol !== "https:" || url.host.toLowerCase() !== place.host.toLowerCase()) return false;
  return `${url.pathname.toLowerCase()}/`.startsWith(`${new URL(placeUrl(place)).pathname.toLowerCase()}/`);
}

/** How to name an address's organization in a sentence: `acme`, or `tfs.example.com/DefaultCollection` on a Server. */
export function placeNameOf(input: string): string | null {
  let url: URL;
  try { url = new URL(canonicalAzureDevOpsUrl(input) ?? input); } catch { return null; }
  const first = url.pathname.split("/")[1];
  if (!first) return null;
  const name = decodeURIComponent(first);
  return isServices(url.host) ? name : `${url.host}/${name}`;
}

/** A work item page: https://<place>/[<project>/]_workitems/edit/<id>. */
export function isWorkItemUrl(input: string): boolean {
  try { return /\/_workitems\/edit\/[1-9][0-9]{0,9}\/?$/.test(new URL(canonicalAzureDevOpsUrl(input) ?? input).pathname); }
  catch { return false; }
}
