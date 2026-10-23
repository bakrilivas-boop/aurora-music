import type { CSSProperties, ReactNode } from 'react'

interface IconProps {
  size?: number
  className?: string
  style?: CSSProperties
  filled?: boolean
}

function base(children: ReactNode, { size = 18, className, style, filled }: IconProps, viewBox = '0 0 24 24') {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      className={className}
      style={style}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const IconPlay = (p: IconProps) => base(<path d="M8 5.2v13.6a1 1 0 0 0 1.53.85l10.6-6.8a1 1 0 0 0 0-1.7L9.53 4.35A1 1 0 0 0 8 5.2Z" />, { ...p, filled: true })
export const IconPause = (p: IconProps) =>
  base(
    <>
      <rect x="6.5" y="4.8" width="3.6" height="14.4" rx="1.4" />
      <rect x="13.9" y="4.8" width="3.6" height="14.4" rx="1.4" />
    </>,
    { ...p, filled: true },
  )
export const IconPrev = (p: IconProps) =>
  base(
    <>
      <path d="M18.5 5.6v12.8a.8.8 0 0 1-1.24.66L9 13.2v5.2a1 1 0 0 1-2 0V5.6a1 1 0 0 1 2 0v5.2l8.26-5.86a.8.8 0 0 1 1.24.66Z" />
    </>,
    { ...p, filled: true },
  )
export const IconNext = (p: IconProps) =>
  base(
    <>
      <path d="M5.5 5.6v12.8a.8.8 0 0 0 1.24.66L15 13.2v5.2a1 1 0 0 0 2 0V5.6a1 1 0 0 0-2 0v5.2L6.74 4.94A.8.8 0 0 0 5.5 5.6Z" />
    </>,
    { ...p, filled: true },
  )
export const IconShuffle = (p: IconProps) =>
  base(
    <>
      <path d="M17 3.5 21 7l-4 3.5" />
      <path d="M17 13.5 21 17l-4 3.5" />
      <path d="M3 7h3.2c1.6 0 3.1.8 4 2.1l3.6 5.8c.9 1.3 2.4 2.1 4 2.1H21" />
      <path d="M3 17h3.2c1.6 0 3.1-.8 4-2.1l.9-1.4" />
      <path d="M13.6 9.4l.4-.6c.9-1.3 2.4-2.1 4-2.1H21" />
    </>,
    p,
  )
export const IconRepeat = (p: IconProps) =>
  base(
    <>
      <path d="M17 2.5 21 6l-4 3.5" />
      <path d="M3 12V9a3 3 0 0 1 3-3h15" />
      <path d="M7 21.5 3 18l4-3.5" />
      <path d="M21 12v3a3 3 0 0 1-3 3H3" />
    </>,
    p,
  )
export const IconRepeatOne = (p: IconProps) =>
  base(
    <>
      <path d="M17 2.5 21 6l-4 3.5" />
      <path d="M3 12V9a3 3 0 0 1 3-3h15" />
      <path d="M7 21.5 3 18l4-3.5" />
      <path d="M21 12v3a3 3 0 0 1-3 3H3" />
      <path d="M11.4 10.2 12.8 9v6" strokeWidth={1.6} />
    </>,
    p,
  )
export const IconVolume = (p: IconProps) =>
  base(
    <>
      <path d="M4 9.5h3l4.2-3.6a.8.8 0 0 1 1.3.62v11a.8.8 0 0 1-1.3.62L7 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" />
      <path d="M16.5 8.6a4.6 4.6 0 0 1 0 6.8" />
      <path d="M19.2 5.9a8.4 8.4 0 0 1 0 12.2" />
    </>,
    p,
  )
export const IconVolumeMute = (p: IconProps) =>
  base(
    <>
      <path d="M4 9.5h3l4.2-3.6a.8.8 0 0 1 1.3.62v11a.8.8 0 0 1-1.3.62L7 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" />
      <path d="m16.5 9.5 5 5" />
      <path d="m21.5 9.5-5 5" />
    </>,
    p,
  )
export const IconHeart = (p: IconProps) =>
  base(<path d="M12 20.4s-8.4-4.9-8.4-10.6a4.7 4.7 0 0 1 8.4-2.9 4.7 4.7 0 0 1 8.4 2.9c0 5.7-8.4 10.6-8.4 10.6Z" />, p)
export const IconSearch = (p: IconProps) =>
  base(
    <>
      <circle cx="10.8" cy="10.8" r="6.8" />
      <path d="m16 16 4.5 4.5" />
    </>,
    p,
  )
export const IconLibrary = (p: IconProps) =>
  base(
    <>
      <path d="M4 20V6.8a1 1 0 0 1 1-1h2.4a1 1 0 0 1 1 1V20" />
      <path d="M10.6 20V4.8a1 1 0 0 1 1-1h2.2a1 1 0 0 1 1 1V20" />
      <path d="M17.4 20V8.4l3.4 1v10.6" />
      <path d="M2.6 20h18.8" />
    </>,
    p,
  )
export const IconDisc = (p: IconProps) =>
  base(
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3v3.4M12 17.6V21M3 12h3.4M17.6 12H21" />
    </>,
    p,
  )
export const IconMic = (p: IconProps) =>
  base(
    <>
      <rect x="9" y="2.6" width="6" height="11" rx="3" />
      <path d="M5.5 11.4a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3.4M8.6 21.4h6.8" />
    </>,
    p,
  )
export const IconClock = (p: IconProps) =>
  base(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.4V12l3.2 2" />
    </>,
    p,
  )
export const IconSettings = (p: IconProps) =>
  base(
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 14.2a1.6 1.6 0 0 0 .32 1.76l.06.06a1.9 1.9 0 1 1-2.7 2.7l-.06-.06a1.6 1.6 0 0 0-1.76-.32 1.6 1.6 0 0 0-.97 1.46V21a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.76.32l-.06.06a1.9 1.9 0 1 1-2.7-2.7l.06-.06a1.6 1.6 0 0 0 .32-1.76 1.6 1.6 0 0 0-1.46-.97H3a1.9 1.9 0 1 1 0-3.8h.1a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.76l-.06-.06a1.9 1.9 0 1 1 2.7-2.7l.06.06a1.6 1.6 0 0 0 1.76.32H8.8a1.6 1.6 0 0 0 .97-1.46V3a1.9 1.9 0 1 1 3.8 0v.1a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.76-.32l.06-.06a1.9 1.9 0 1 1 2.7 2.7l-.06.06a1.6 1.6 0 0 0-.32 1.76v.08a1.6 1.6 0 0 0 1.46.97H21a1.9 1.9 0 1 1 0 3.8h-.1a1.6 1.6 0 0 0-1.5.97Z" />
    </>,
    p,
  )
export const IconQueue = (p: IconProps) =>
  base(
    <>
      <path d="M3.5 6.5h11M3.5 11.5h11M3.5 16.5h7" />
      <circle cx="17.6" cy="14.4" r="2.6" />
      <path d="M20.2 14.4V6.9l2-1" />
    </>,
    p,
  )
export const IconLyrics = (p: IconProps) =>
  base(
    <>
      <path d="M4 5.4h16M4 10.2h10M4 15h12M4 19.8h7" />
    </>,
    p,
  )
export const IconEq = (p: IconProps) =>
  base(
    <>
      <path d="M5 21V13.5M5 9.5V3M12 21v-5M12 12V3M19 21v-9.5M19 7.5V3" />
      <path d="M2.8 13.5h4.4M9.8 12h4.4M16.8 7.5h4.4" />
    </>,
    p,
  )
export const IconClose = (p: IconProps) => base(<path d="m5.5 5.5 13 13M18.5 5.5l-13 13" />, p)
export const IconMenu = (p: IconProps) => base(<path d="M4 6h16M4 12h16M4 18h16" />, p)
export const IconFolder = (p: IconProps) =>
  base(
    <path d="M3 7.4a1.8 1.8 0 0 1 1.8-1.8h4l2 2.4h8.4A1.8 1.8 0 0 1 21 9.8v8.4a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 18.2Z" />,
    p,
  )
export const IconPlus = (p: IconProps) => base(<path d="M12 5v14M5 12h14" />, p)
export const IconTrash = (p: IconProps) =>
  base(
    <>
      <path d="M4 7h16M9.5 7V4.8h5V7M6.6 7l.9 12.2a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5L18.4 7" />
      <path d="M10.4 11v6M13.6 11v6" />
    </>,
    p,
  )
export const IconCheck = (p: IconProps) => base(<path d="m4.5 12.5 5 5 10-11" />, p)
export const IconMusic = (p: IconProps) =>
  base(
    <>
      <circle cx="7" cy="17.4" r="3.4" />
      <circle cx="18" cy="15.4" r="3.4" />
      <path d="M10.4 17.4V6.2l11-2.4v11.6" />
    </>,
    p,
  )
export const IconArrowUp = (p: IconProps) => base(<path d="m6 14 6-6 6 6" />, p)
export const IconArrowDown = (p: IconProps) => base(<path d="m6 10 6 6 6-6" />, p)
export const IconMinimize = (p: IconProps) => base(<path d="M5 12h14" />, p)
export const IconRefresh = (p: IconProps) =>
  base(
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4.5h-4.5" />
    </>,
    p,
  )
export const IconSpark = (p: IconProps) =>
  base(
    <>
      <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9Z" />
      <path d="M18.6 16.4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" />
    </>,
    p,
  )
