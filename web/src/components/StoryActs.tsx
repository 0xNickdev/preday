import { Link } from 'react-router-dom'
import { m, useTransform, type MotionValue } from 'motion/react'
import { inOutCubic, outCubic, range } from '../lib/scrub'
import { Dither, type Region } from './Dither'
import { Words } from './Words'

type Progress = MotionValue<number>

const PAPER = '#f7f7f5'
const GIVING: Region = [0, 0.06, 0.47, 0.4]
const RECEIVING: Region = [0.53, 0.55, 0.47, 0.4]

/** The headline. Its first line rises while the stage is still scrolling into view. */
export function Incoming({ p, enter }: { p: Progress; enter: Progress }) {
  const leave = useTransform(p, (v) => range(v, [0.18, 0.24], inOutCubic))
  const opacity = useTransform(leave, (v) => 1 - v)
  const left = useTransform(leave, (v) => `${-9 * v}vw`)
  const right = useTransform(leave, (v) => `${9 * v}vw`)

  return (
    <m.div className="act incoming" style={{ opacity }}>
      <h2 className="story-head">
        <m.span style={{ x: left }}>
          <Words text="Your next payment" p={enter} from={0.3} step={0.1} span={0.5} />
        </m.span>
        <m.span className="dim" style={{ x: right }}>
          <Words text="is already on its way." p={p} from={0.02} />
        </m.span>
      </h2>
    </m.div>
  )
}

const LINE = 'Take part of it today.'

/** Two hands assemble out of pixels and reach for each other across one highlighted line. */
export function Advance({ p }: { p: Progress }) {
  const reveal = useTransform(p, (v) => range(v, [0.22, 0.37]) * (1 - range(v, [0.45, 0.5])))
  const reach = useTransform(p, (v) => 1 - range(v, [0.22, 0.46], outCubic))
  const fromLeft = useTransform(reach, (v) => `${-7 * v}vw`)
  const fromRight = useTransform(reach, (v) => `${7 * v}vw`)
  const opacity = useTransform(p, (v) => range(v, [0.25, 0.29]) * (1 - range(v, [0.45, 0.49])))
  const wipe = useTransform(p, (v) => `inset(0 ${100 * (1 - range(v, [0.3, 0.41], inOutCubic))}% 0 0)`)

  return (
    <div className="act">
      <m.div className="hand" style={{ x: fromLeft }}>
        <Dither region={GIVING} cellSize={6} color={PAPER} reveal={reveal} />
      </m.div>
      <m.div className="hand take" style={{ x: fromRight }}>
        <Dither region={RECEIVING} cellSize={6} color={PAPER} reveal={reveal} />
      </m.div>
      <m.p className="story-line" style={{ opacity }}>
        {LINE}
        <m.span aria-hidden="true" style={{ clipPath: wipe }}>
          {LINE}
        </m.span>
      </m.p>
    </div>
  )
}

/** Text that types on a character at a time. The font is monospaced, so the clip steps cleanly. */
function Typed({ p, between, children }: { p: Progress; between: [number, number]; children: string }) {
  const clipPath = useTransform(p, (v) => {
    const typed = Math.round(range(v, between) * children.length)
    return `inset(0 ${100 * (1 - typed / children.length)}% 0 0)`
  })
  return <m.span style={{ clipPath }}>{children}</m.span>
}

function Row({ p, at, label, amount }: { p: Progress; at: number; label: string; amount: string }) {
  const shown = useTransform(p, (v) => range(v, [at, at + 0.02], outCubic))
  const y = useTransform(shown, (v) => 8 * (1 - v))
  return (
    <m.div style={{ opacity: shown, y }}>
      <dt>{label}</dt>
      <dd>{amount}</dd>
    </m.div>
  )
}

/** One payment arrives, the advance comes off the top, and the rest travels to the wallet. */
export function Settlement({ p }: { p: Progress }) {
  const arrive = useTransform(p, (v) => range(v, [0.48, 0.515], outCubic))
  const opacity = useTransform(p, (v) => range(v, [0.48, 0.51]) * (1 - range(v, [0.71, 0.745])))
  const y = useTransform(arrive, (v) => 28 * (1 - v))
  const wire = useTransform(p, (v) => range(v, [0.5, 0.55], outCubic))
  const trip = useTransform(p, (v) => range(v, [0.65, 0.69], inOutCubic))
  const packetX = useTransform(trip, (v) => `${100 * v}%`)
  const packetOpacity = useTransform(trip, (v) => (v > 0 && v < 1 ? 1 : 0))
  const landed = useTransform(p, (v) => 0.35 + 0.65 * range(v, [0.685, 0.7]))
  const credited = useTransform(p, (v) => range(v, [0.685, 0.7]))

  return (
    <m.div className="act settle" style={{ opacity, y }}>
      <div className="ticket num">
        <p className="ticket-top">
          <Typed p={p} between={[0.5, 0.55]}>
            Studio Nord → preday.app/anna
          </Typed>
        </p>
        <p className="ticket-sum">
          <Typed p={p} between={[0.55, 0.58]}>
            $1,180.00
          </Typed>
        </p>
        <dl>
          <Row p={p} at={0.59} label="advance repaid" amount="-$100.00" />
          <Row p={p} at={0.61} label="fee" amount="-$5.00" />
          <Row p={p} at={0.63} label="to your wallet" amount="$1,075.00" />
        </dl>
      </div>
      <div className="wire" aria-hidden="true">
        <m.i style={{ scaleX: wire }} />
        <m.b style={{ x: packetX, opacity: packetOpacity }} />
      </div>
      <m.p className="wallet num" style={{ opacity: landed }}>
        your wallet
        <m.span style={{ opacity: credited }}>+$1,075.00</m.span>
      </m.p>
    </m.div>
  )
}

/** The closing line, and the one action the story leads to. */
export function Done({ p }: { p: Progress }) {
  const shown = useTransform(p, (v) => range(v, [0.87, 0.91], outCubic))
  const y = useTransform(shown, (v) => 14 * (1 - v))
  // Out of the tab order until it can be seen.
  const visibility = useTransform(shown, (v) => (v > 0 ? 'visible' : 'hidden'))

  return (
    <div className="act done">
      <h2 className="story-head">
        <span>
          <Words text="Nothing to remember." p={p} from={0.745} />
        </span>
        <span className="dim">
          <Words text="It settles itself." p={p} from={0.8} />
        </span>
      </h2>
      <m.div style={{ opacity: shown, y, visibility }}>
        <Link to="/app" className="btn glow">
          Claim your pay link
        </Link>
      </m.div>
    </div>
  )
}
