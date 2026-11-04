"use client";

import { useState, useTransition } from "react";

// Legacy Utah-only county fallback list, kept for the early-validation Utah
// addresses where the full precinct-and-race bridge is populated. National
// rollout of the county fallback (per-state county lists + state-aware lookup)
// is a separate workstream — Havesay accepts addresses from any U.S.
// state via the primary geocode path; this fallback is the rural-route /
// PO-Box edge case which was scoped to Utah in early validation.
const UTAH_COUNTIES_LEGACY = [
  "Beaver", "Box Elder", "Cache", "Carbon", "Daggett", "Davis", "Duchesne",
  "Emery", "Garfield", "Grand", "Iron", "Juab", "Kane", "Millard", "Morgan",
  "Piute", "Rich", "Salt Lake", "San Juan", "Sanpete", "Sevier", "Summit",
  "Tooele", "Uintah", "Utah", "Wasatch", "Washington", "Wayne", "Weber",
];

// USPS state + territory list with 2-letter codes. Order matches USPS
// Publication 28 — alphabetical by state name with DC and territories at
// the end so they're not lost in the alphabetical scroll.
const US_STATES = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
  { code: "DC", name: "District of Columbia" },
  { code: "AS", name: "American Samoa" },
  { code: "GU", name: "Guam" },
  { code: "MP", name: "Northern Mariana Islands" },
  { code: "PR", name: "Puerto Rico" },
  { code: "VI", name: "U.S. Virgin Islands" },
];

export default function AddressInput({
  action,
}: {
  // Server actions may either redirect (returning void) or return an
  // { error } payload. The payload may also carry `no_coverage: true` when
  // geocoding SUCCEEDED but we simply have no ballot data for that point —
  // which is a coverage gap, not a bad address, and must not be framed as a
  // PO-box / rural-route problem.
  action: (
    formData: FormData,
  ) => Promise<
    void | { error?: string; no_coverage?: boolean } | undefined
  >;
}) {
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showCountyFallback, setShowCountyFallback] = useState(false);
  // Distinguishes "we found your address but have no data for your area yet"
  // (no_coverage) from "we couldn't find/geocode your address" (the PO-box /
  // rural-route case that the county fallback addresses).
  const [noCoverage, setNoCoverage] = useState(false);
  const [isPending, startTransition] = useTransition();

  function clearError() {
    if (error) setError(null);
    setShowCountyFallback(false);
    setNoCoverage(false);
  }

  function validate(): string | null {
    if (!street.trim()) return "Please enter your street address.";
    if (!city.trim()) return "Please enter your city.";
    if (!state) return "Please select your state.";
    if (!zip.trim()) return "Please enter your ZIP code.";
    if (!/^\d{5}(-\d{4})?$/.test(zip.trim())) {
      return "ZIP code should be 5 digits (or 5+4).";
    }
    return null;
  }

  function buildAddressString(): string {
    // Geocoders (Census, Nominatim) parse comma-separated structured
    // addresses more reliably than free-form. Format: "street, city, ST zip".
    return `${street.trim()}, ${city.trim()}, ${state} ${zip.trim()}`;
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    const formData = new FormData();
    formData.set("address", buildAddressString());
    // Also pass structured fields so the server action can use them directly
    // if/when the geocode API prefers structured input.
    formData.set("street", street.trim());
    formData.set("city", city.trim());
    formData.set("state", state);
    formData.set("zip", zip.trim());

    startTransition(async () => {
      try {
        const result = await action(formData);
        if (
          result &&
          typeof result === "object" &&
          "error" in result &&
          result.error
        ) {
          setError(result.error);
          if (
            "no_coverage" in result &&
            (result as { no_coverage?: boolean }).no_coverage
          ) {
            // Geocoded fine, but no ballot data for this point. This is NOT a
            // PO-box / rural-route problem, so don't offer the county
            // fallback — show the honest no-coverage message instead.
            setNoCoverage(true);
            setShowCountyFallback(false);
          } else {
            // Could not find/geocode the address. Offer the county fallback
            // (Utah) / rural-route guidance.
            setShowCountyFallback(true);
          }
        }
      } catch (e) {
        // Next.js Server Action redirects throw a NEXT_REDIRECT error
        // that MUST bubble up so the navigation completes. Re-throw it.
        // Without this guard the success path flashes the generic error
        // for a frame before the redirect lands.
        if (
          e &&
          typeof e === "object" &&
          "digest" in e &&
          typeof (e as { digest?: unknown }).digest === "string" &&
          ((e as { digest: string }).digest.startsWith("NEXT_REDIRECT") ||
            (e as { digest: string }).digest.startsWith("NEXT_NOT_FOUND"))
        ) {
          throw e;
        }
        setError(
          "We couldn't find that address. Double-check the street, city, and ZIP, or pick your county below if you're in Utah.",
        );
        setShowCountyFallback(true);
      }
    });
  }

  function handleCountySelect(e: React.ChangeEvent<HTMLSelectElement>) {
    const county = e.target.value;
    if (!county) return;
    setError(null);
    const formData = new FormData();
    formData.set("address", `${county} County, Utah`);
    formData.set("county_fallback", "true");
    startTransition(async () => {
      try {
        const result = await action(formData);
        if (
          result &&
          typeof result === "object" &&
          "error" in result &&
          result.error
        ) {
          setError(result.error);
        }
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          "digest" in err &&
          typeof (err as { digest?: unknown }).digest === "string" &&
          ((err as { digest: string }).digest.startsWith("NEXT_REDIRECT") ||
            (err as { digest: string }).digest.startsWith("NEXT_NOT_FOUND"))
        ) {
          throw err;
        }
        setError("County lookup failed. Please try again.");
      }
    });
  }

  // skbox-style field: civic surface, strong border, focus → primary.
  // Matches the frame's address field (single bordered box with the location
  // glyph) while keeping the structured street/city/state/zip inputs the
  // geocoder needs. STYLING ONLY — behavior below is unchanged.
  const inputBase =
    "px-4 py-3 text-base rounded-lg border transition-colors outline-none bg-[var(--civic-surface)] text-[var(--civic-text)] placeholder:text-[var(--civic-text-muted)] disabled:opacity-60";
  const inputBorder = error
    ? "border-[var(--state-error-fg)] focus:border-[var(--state-error-fg)]"
    : "border-[var(--civic-border-strong)] focus:border-[var(--civic-primary)]";

  return (
    <form onSubmit={handleSubmit} className="w-full">
      {/* skbox: bordered card grouping the address fields with the location
          glyph, echoing the frame's single address box. */}
      <div className="rounded-xl border border-[var(--civic-border-strong)] bg-[var(--civic-surface)] p-3 sm:p-4 shadow-[var(--shadow-card)] space-y-3">
        {/* Street — full width, with leading location glyph */}
        <div className="relative">
          <label htmlFor="bb-street" className="sr-only">
            Street address
          </label>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--civic-text-muted)] text-lg"
          >
            {"📍"}
          </span>
          <input
            id="bb-street"
            type="text"
            name="street"
            value={street}
            onChange={(e) => {
              setStreet(e.target.value);
              clearError();
            }}
            placeholder="123 Main St, your city"
            autoComplete="address-line1"
            disabled={isPending}
            className={`${inputBase} ${inputBorder} w-full pl-10`}
          />
        </div>

        {/* City + State + ZIP — row on desktop, stacked on mobile */}
        <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_1fr] gap-3">
          <div>
            <label htmlFor="bb-city" className="sr-only">
              City
            </label>
            <input
              id="bb-city"
              type="text"
              name="city"
              value={city}
              onChange={(e) => {
                setCity(e.target.value);
                clearError();
              }}
              placeholder="City"
              autoComplete="address-level2"
              disabled={isPending}
              className={`${inputBase} ${inputBorder} w-full`}
            />
          </div>
          <div>
            <label htmlFor="bb-state" className="sr-only">
              State
            </label>
            <select
              id="bb-state"
              name="state"
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                clearError();
              }}
              disabled={isPending}
              className={`${inputBase} ${inputBorder} w-full appearance-none`}
            >
              <option value="" disabled>
                State
              </option>
              {US_STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code}: {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="bb-zip" className="sr-only">
              ZIP code
            </label>
            <input
              id="bb-zip"
              type="text"
              name="zip"
              inputMode="numeric"
              pattern="[0-9]{5}(-[0-9]{4})?"
              maxLength={10}
              value={zip}
              onChange={(e) => {
                setZip(e.target.value);
                clearError();
              }}
              placeholder="ZIP"
              autoComplete="postal-code"
              disabled={isPending}
              className={`${inputBase} ${inputBorder} w-full`}
            />
          </div>
        </div>

        {error && (
          <p
            className="text-sm font-medium text-[var(--state-error-fg)]"
            role="alert"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={isPending}
          className="civic-btn civic-btn-primary civic-btn-lg w-full"
        >
          {isPending ? (
            <span className="inline-flex items-center gap-2">
              <svg
                className="animate-spin h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Looking up...
            </span>
          ) : (
            "See my ballot →"
          )}
        </button>
      </div>

      {/* No-coverage case: geocoding succeeded but we simply have no ballot
          data for this point yet. Honest framing, distinct from the
          address-not-found / PO-box case. No county fallback here — the
          address was fine. */}
      {noCoverage && (
        <div className="mt-4 p-4 bg-[var(--civic-surface-muted)] rounded-lg border border-[var(--civic-border)]">
          <p className="text-sm text-[var(--civic-text-secondary)]">
            We found your address, but we don&apos;t have ballot data for your
            area yet. We&apos;re adding coverage across all 50 states over time,
            starting with federal, statewide, and state legislative races. Check
            back soon.
          </p>
        </div>
      )}

      {/* Address-not-found case: could not geocode (often a PO Box or rural
          route). Offer the Utah county fallback; other states get honest
          guidance to retry with a street address. */}
      {showCountyFallback && !noCoverage && (
        <div className="mt-4 p-4 bg-[var(--civic-surface-muted)] rounded-lg border border-[var(--civic-border)]">
          <p className="text-sm text-[var(--civic-text-secondary)] mb-2">
            PO Boxes and rural routes can&apos;t be geocoded.
            {state === "UT" || state === "" ? (
              " If you're in Utah, you can pick a county below as a fallback."
            ) : (
              " Please try a street address (no PO Box) so we can locate your districts."
            )}
          </p>
          {(state === "UT" || state === "") && (
            <select
              onChange={handleCountySelect}
              disabled={isPending}
              className="w-full px-4 py-3 rounded-lg border border-[var(--civic-border-strong)] bg-[var(--civic-surface)] text-[var(--civic-text)]"
              defaultValue=""
            >
              <option value="" disabled>
                Pick your Utah county...
              </option>
              {UTAH_COUNTIES_LEGACY.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </form>
  );
}
