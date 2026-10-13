import { Money } from '@uconext/shared';
import { formatDashboardAmount } from './dashboard-presentation';
import styles from './trend-chart.module.css';

export type TrendSeries = { id: string; name: string; values: readonly string[]; display: readonly string[] };
// Dark tones stay distinct against the report surface; patterns and the value table supplement color.
const seriesColors = ['#166534', '#1d4ed8', '#b45309', '#be123c', '#7e22ce', '#0e7490',
  '#4338ca', '#a16207', '#9d174d', '#0f766e', '#6d28d9', '#9a3412'];
const seriesPatterns = ['none', '10 5', '3 5', '14 4 3 4'];

function chartStep(maximum: bigint, minimum: bigint): bigint {
  const target = (maximum + 3n) / 4n;
  let magnitude = minimum;
  while (magnitude * 10n < target) magnitude *= 10n;
  for (const factor of [1n, 2n, 5n, 10n]) {
    if (magnitude * factor >= target) return magnitude * factor;
  }
  return magnitude * 10n;
}

function formatMoneyTick(cents: bigint): string {
  if (cents === 0n) return '0';
  if (cents >= 100_000n) return new Intl.NumberFormat('es-AR', {
    notation: 'compact', maximumFractionDigits: 1,
  }).format(cents / 100n);
  return formatDashboardAmount(`${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`);
}

export function TrendChart({ title, values, labels, display, currency, headingLevel = 4, series }: { title: string; values: readonly string[];
  labels: readonly string[]; display: readonly string[]; currency?: string; headingLevel?: 3 | 4; series?: readonly TrendSeries[] }) {
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  const plotted = (series ?? [{ id: 'total', name: title, values, display }]).map((entry, index) => ({
    ...entry, color: seriesColors[index] ?? `hsl(${(index * 137.508) % 360} 65% 32%)`, pattern: seriesPatterns[index % seriesPatterns.length] ?? 'none',
    units: entry.values.map(value => BigInt(Money.from(value).toString().replace('.', ''))),
  }));
  const units = plotted.flatMap(entry => entry.units);
  const maximum = units.reduce((max, value) => value > max ? value : max, 0n);
  const step = chartStep(maximum, currency ? 1n : 100n);
  const ceiling = step * 4n;
  const valueTicks = Array.from({ length: 5 }, (_, index) => {
    const amount = step * BigInt(4 - index);
    return { y: 24 + index * 40, label: currency ? formatMoneyTick(amount) : String(amount / 100n) };
  });
  // Five full dates collide in a week at the chart's minimum rendered width.
  const referenceCount = labels.length <= 8 ? 3 : 5;
  const timeIndexes = labels.length ? [...new Set(Array.from({ length: referenceCount }, (_, index) =>
    Math.round(index * (labels.length - 1) / (referenceCount - 1))))] : [];
  const coordinates = (entry: typeof plotted[number]) => entry.units.map((value, index) => ({
    x: labels.length === 1 ? 270 : 90 + Math.round(index * 360 / (labels.length - 1)),
    y: 184 - Number(value * 160n / ceiling),
  }));
  const peakSeries = plotted.find(entry => entry.units.includes(maximum));
  const peak = peakSeries?.display[peakSeries.units.indexOf(maximum)] ?? '0';
  return <section className={styles.chart} aria-label={title}>
    <Heading>{title}</Heading>
    {series && <ul className={styles.legend} aria-label="Categorías del gráfico">{plotted.map(entry => <li key={entry.id}>
      <svg viewBox="0 0 40 12" aria-hidden="true" focusable="false"><line x1="2" y1="6" x2="38" y2="6"
        stroke={entry.color} strokeWidth="4" strokeDasharray={entry.pattern} /></svg><span>{entry.name}</span>
    </li>)}</ul>}
    <div className={styles.chartPlot} tabIndex={0} role="region"
      aria-label={`Gráfico de ${title}; desplazamiento horizontal disponible`}>
      <p className={styles.chartPeak}>Máximo: {peak}</p>
      <svg viewBox="0 0 500 225" aria-hidden="true" focusable="false">
        {valueTicks.map(tick => <g key={tick.y}>
          <line x1="90" y1={tick.y} x2="450" y2={tick.y}
            className={tick.y === 184 ? styles.chartAxis : styles.chartGridLine} />
          <text data-axis="value" x="80" y={tick.y + 4} textAnchor="end" className={styles.chartTick}>{tick.label}</text>
        </g>)}
        {plotted.map(entry => <g key={entry.id}>
          <polyline points={coordinates(entry).map(point => `${point.x},${point.y}`).join(' ')}
            stroke={entry.color} style={{ stroke: entry.color }} strokeDasharray={series ? entry.pattern : undefined} className={styles.chartLine} />
          {coordinates(entry).map((point, index) => <circle key={labels[index]} cx={point.x} cy={point.y}
            r={series ? 4 : values.length > 16 ? 5 : 7} style={{ fill: entry.color }} className={styles.chartPoint} />)}
        </g>)}
        {timeIndexes.map(index => <text key={index} data-axis="time" x={labels.length === 1 ? 270 : 90 + Math.round(index * 360 / (labels.length - 1))}
          y="213" textAnchor={index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle'}
          className={styles.chartTick}>{formatChartDate(labels[index] ?? '')}</text>)}
      </svg>
    </div>
    <details className={styles.chartDetails}><summary>Ver valores {labels[0]?.includes('T') ? 'por hora' : 'diarios'}</summary>
      <table><thead><tr><th scope="col">{labels[0]?.includes('T') ? 'Hora' : 'Día'}</th>
        {plotted.map(entry => <th scope="col" key={entry.id}>{entry.name}</th>)}</tr></thead>
        <tbody>{labels.map((label, index) => <tr key={label}><th scope="row"><time dateTime={label}>
          {formatChartDate(label)}</time></th>{plotted.map(entry => <td key={entry.id}>{entry.display[index]}</td>)}</tr>)}</tbody></table>
    </details>
  </section>;
}

function formatChartDate(date: string): string {
  if (date.includes('T')) return `${date.slice(11)} h`;
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('es-AR', {
    timeZone: 'UTC', day: 'numeric', month: 'short' });
}
