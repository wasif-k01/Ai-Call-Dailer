import { getCountries, getCountryCallingCode, type CountryCode } from "libphonenumber-js";

export interface Country {
  iso: CountryCode;
  name: string;
  dialCode: string;
  flag: string;
}

const PINNED: CountryCode[] = ["US", "AE", "GB", "PK"];

export function flagOf(iso: string) {
  return /^[A-Z]{2}$/.test(iso) ? String.fromCodePoint(...[...iso].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "🌐";
}

let cache: Country[] | null = null;
/** All countries with calling codes; US, UAE, UK, Pakistan first. */
export function countries(): Country[] {
  if (cache) return cache;
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const all = getCountries().map((iso) => ({
    iso,
    name: names.of(iso) ?? iso,
    dialCode: `+${getCountryCallingCode(iso)}`,
    flag: flagOf(iso),
  }));
  const pinned = PINNED.map((p) => all.find((c) => c.iso === p)!).filter(Boolean);
  cache = [...pinned, ...all.filter((c) => !PINNED.includes(c.iso)).sort((a, b) => a.name.localeCompare(b.name))];
  return cache;
}
