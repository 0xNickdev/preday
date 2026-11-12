import { Link } from 'react-router-dom'

/** A single dot with the part you can take early already lit. */
export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="Preday home">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <clipPath id="logo-dot">
          <circle cx="12" cy="12" r="11" />
        </clipPath>
        <rect width="10" height="24" fill="var(--amber)" clipPath="url(#logo-dot)" />
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      preday
    </Link>
  )
}
