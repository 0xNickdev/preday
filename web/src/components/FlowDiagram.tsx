/**
 * How one payment moves, as an isometric line drawing. Everything sits on a 30 degree grid:
 * a step along the floor is (COS, SIN) per unit, and straight up is the vertical axis.
 */

const COS = Math.cos(Math.PI / 6)
const SIN = 0.5
const CHAR = 6.6
const CHIP = 22
const PAD = 8
const GAP = 6
const SPECTRUM = ['#ffcf5a', '#7dffa8', '#5ad7ff', '#9b7bff', '#ff6fd8', '#ffb36b']

type Point = [x: number, y: number]

const points = (list: Point[]) => list.map((point) => point.join(',')).join(' ')

/** The floor outline of a square with half-diagonal `s`, centred on [x, y]. */
const rhombus = ([x, y]: Point, s: number): Point[] => [
  [x, y - s * SIN],
  [x + s * COS, y],
  [x, y + s * SIN],
  [x - s * COS, y],
]

/** A cube standing on the floor point `at`. */
function Cube({ at: [x, y], s }: { at: Point; s: number }) {
  const [north, east, south, west] = rhombus([x, y - s], s)
  const drop = ([px, py]: Point): Point => [px, py + s]
  return (
    <g className="solid">
      <polygon className="plate" points={points(rhombus([x, y], s * 1.7))} />
      <polygon points={points([west, south, drop(south), drop(west)])} />
      <polygon className="shade" points={points([south, east, drop(east), drop(south)])} />
      <polygon points={points([north, east, south, west])} />
    </g>
  )
}

/** Discs stacked up from the floor point `at`. `top` paints the face of the highest one. */
function Stack({ at: [x, y], r, count, top }: { at: Point; r: number; count: number; top?: string }) {
  const ry = r * SIN * 1.15
  const thick = r * 0.19
  const pitch = thick * 1.5
  return (
    <g className="solid">
      <polygon className="plate" points={points(rhombus([x, y], r * 1.9))} />
      {Array.from({ length: count }, (_, i) => {
        const face = y - i * pitch - thick
        return (
          <g key={i}>
            <path d={`M${x - r} ${face}v${thick}a${r} ${ry} 0 0 0 ${2 * r} 0v${-thick}`} />
            <ellipse cx={x} cy={face} rx={r} ry={ry} fill={i === count - 1 ? top : undefined} />
          </g>
        )
      })}
    </g>
  )
}

const chipWidth = (label: string) => label.length * CHAR + PAD * 2

/** A row of mono chips. `at` is the top of the row, at its centre, or at its left edge with `start`. */
function Chips({ at: [x, y], labels, start }: { at: Point; labels: string[]; start?: boolean }) {
  const total = labels.reduce((sum, label) => sum + chipWidth(label) + GAP, -GAP)
  let left = start ? x : x - total / 2
  return labels.map((label) => {
    const width = chipWidth(label)
    const chip = (
      <g key={label} className="chip">
        <rect x={left} y={y} width={width} height={CHIP} rx="4" />
        <text x={left + width / 2} y={y + 15}>
          {label}
        </text>
      </g>
    )
    left += width + GAP
    return chip
  })
}

/** A dotted connector with one packet travelling along it. `at` is when in the cycle the packet leaves. */
function Wire({ from, to, at, rare }: { from: Point; to: Point; at: number; rare?: boolean }) {
  const d = `M${from.join(' ')}L${to.join(' ')}`
  return (
    <>
      <path className="wire-dots" d={d} />
      <path className={rare ? 'packet rare' : 'packet'} d={d} pathLength="100" style={{ animationDelay: `${at - 12}s` }} />
    </>
  )
}

/** Three stacked floor tiles, drifting. */
function Glyph({ at: [x, y], delay }: { at: Point; delay: number }) {
  return (
    <g className="glyph" style={{ animationDelay: `${-delay}s` }}>
      {[10, 5, 0].map((lift) => (
        <polygon key={lift} points={points(rhombus([x, y + lift], 13))} />
      ))}
    </g>
  )
}

/** Floor points of every node, then where the loose parts go. One per shape of screen. */
const WIDE = {
  name: 'wide',
  box: '0 72 1100 488',
  client: [170, 262] as Point,
  account: [404, 397] as Point,
  preday: [638, 262] as Point,
  wallet: [924, 427] as Point,
  pool: [638, 500] as Point,
  poolLabel: [556, 462] as Point,
  poolChips: [
    [728, 452],
    [728, 480],
  ] as Point[],
  cube: 58,
  disc: 80,
  glyphs: [
    [296, 118],
    [820, 150],
    [1010, 250],
    [250, 470],
  ] as Point[],
}

const TALL: typeof WIDE = {
  name: 'tall',
  box: '0 36 400 754',
  client: [94, 150],
  account: [302, 270],
  preday: [102, 385.5],
  wallet: [302, 501],
  pool: [102, 700],
  poolLabel: [192, 684],
  poolChips: [
    [20, 747],
    [95, 747],
  ],
  cube: 48,
  disc: 60,
  glyphs: [
    [330, 96],
    [40, 500],
    [300, 690],
  ],
}

function Diagram({ layout }: { layout: typeof WIDE }) {
  const { client, account, preday, wallet, pool, cube, disc } = layout
  const gradient = `spectrum-${layout.name}`
  const over = cube * 1.5 + 14
  const under = ([x, y]: Point, row = 0): Point => [x, y + cube * 0.85 + 12 + row * (CHIP + GAP)]
  const name = (text: string, [x, y]: Point, lift: number) => (
    <text className="name" x={x} y={y - lift}>
      {text}
    </text>
  )

  return (
    <svg
      className={`flow ${layout.name}`}
      viewBox={layout.box}
      role="img"
      aria-label="A client pays in any coin to Anna's pay account. Preday repays any advance to the pool and sends the rest to Anna's wallet."
    >
      <defs>
        <linearGradient id={gradient}>
          {SPECTRUM.map((color, i) => (
            <stop key={color} offset={i / (SPECTRUM.length - 1)} stopColor={color} />
          ))}
        </linearGradient>
      </defs>

      {layout.glyphs.map((at, i) => (
        <Glyph key={i} at={at} delay={i * 1.7} />
      ))}

      <Wire from={client} to={account} at={0} />
      <Wire from={account} to={preday} at={1.3} />
      <Wire from={preday} to={wallet} at={2.6} />
      <Wire from={preday} to={pool} at={2.6} rare />

      <Stack at={pool} r={disc * 0.62} count={3} />
      <Cube at={client} s={cube} />
      <Cube at={account} s={cube} />
      <Stack at={preday} r={disc} count={4} top={`url(#${gradient})`} />
      <Cube at={wallet} s={cube} />

      {name('Client', client, over)}
      {name('Pay account', account, over)}
      {name('Preday', preday, disc * 1.62 + 16)}
      {name("Anna's wallet", wallet, over)}
      {name('Pool', layout.poolLabel, 0)}

      <Chips at={under(client)} labels={['USDT', 'ETH', 'SOL']} />
      <Chips at={under(account)} labels={['ANNA.PREDAY.NEAR']} />
      <Chips at={under(account, 1)} labels={['NO KEYS']} />
      <Chips at={under(wallet)} labels={['YOUR WALLET']} />
      <Chips at={layout.poolChips[0]} labels={['POOL 80%']} start />
      <Chips at={layout.poolChips[1]} labels={['RESERVE 20%']} start />
    </svg>
  )
}

export function FlowDiagram() {
  return (
    <>
      <Diagram layout={WIDE} />
      <Diagram layout={TALL} />
    </>
  )
}
