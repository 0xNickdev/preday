import { m, useTransform, type MotionValue } from 'motion/react'
import { outCubic, range } from '../lib/scrub'

function Word({ p, at, span, children }: { p: MotionValue<number>; at: number; span: number; children: string }) {
  const y = useTransform(p, (v) => `${120 * (1 - range(v, [at, at + span], outCubic))}%`)
  return (
    <>
      <span className="mask">
        <m.span style={{ y }}>{children}</m.span>
      </span>{' '}
    </>
  )
}

/** A line whose words rise out of their own masks one after another as `p` passes `from`. */
export function Words({
  text,
  p,
  from,
  step = 0.022,
  span = 0.06,
}: {
  text: string
  p: MotionValue<number>
  from: number
  step?: number
  span?: number
}) {
  return text.split(' ').map((word, i) => (
    <Word key={i} p={p} at={from + i * step} span={span}>
      {word}
    </Word>
  ))
}
