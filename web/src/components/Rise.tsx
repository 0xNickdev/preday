import type { ReactNode } from 'react'
import { m } from 'motion/react'

/** A block that fades up once when it scrolls into view. `index` staggers siblings. */
export function Rise({ index, children }: { index: number; children: ReactNode }) {
  return (
    <m.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -8% 0px' }}
      transition={{ duration: 0.5, delay: index * 0.06, ease: [0.2, 0.7, 0.2, 1] }}
    >
      {children}
    </m.div>
  )
}
