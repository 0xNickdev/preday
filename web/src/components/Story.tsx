import { useRef, useState } from 'react'
import {
  m,
  motionValue,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  type MotionValue,
} from 'motion/react'
import { Advance, Done, Incoming, Settlement } from './StoryActs'

const ACTS = ['incoming', 'advance', 'settlement', 'done']
const BOUNDS = [0.22, 0.48, 0.72]
const SPRING = { stiffness: 500, damping: 30, mass: 0.4 }

/** The progress at which each act is fully shown. Without scrubbing, every act is drawn at its own. */
const POSTER = [0.17, 0.43, 0.705, 1].map((at) => motionValue(at))

function Hud({ p }: { p: MotionValue<number> }) {
  const [act, setAct] = useState(0)
  useMotionValueEvent(p, 'change', (v) => setAct(BOUNDS.filter((bound) => v >= bound).length))

  return (
    <div className="hud" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <span>
        0{act + 1} / 0{ACTS.length}
      </span>
      <span>{ACTS[act]}</span>
      <m.b style={{ scaleX: p }} />
    </div>
  )
}

/** A stage pinned for the length of its track. Scrolling the track plays the four acts. */
function Scrubbed() {
  const track = useRef<HTMLElement>(null)
  const p = useSpring(useScroll({ target: track, offset: ['start start', 'end end'] }).scrollYProgress, SPRING)
  const enter = useSpring(useScroll({ target: track, offset: ['start end', 'start start'] }).scrollYProgress, SPRING)

  return (
    <section className="story-track" ref={track}>
      <div className="story-stage">
        <Incoming p={p} enter={enter} />
        <Advance p={p} />
        <Settlement p={p} />
        <Done p={p} />
        <Hud p={p} />
      </div>
    </section>
  )
}

/** The same four acts, one under another, each finished. */
function Still() {
  return (
    <section className="story-track still">
      <div className="story-stage">
        <Incoming p={POSTER[0]} enter={POSTER[3]} />
        <Advance p={POSTER[1]} />
        <Settlement p={POSTER[2]} />
        <Done p={POSTER[3]} />
      </div>
    </section>
  )
}

export function Story() {
  return useReducedMotion() ? <Still /> : <Scrubbed />
}
