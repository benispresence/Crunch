<script setup lang="ts">
/**
 * In-app guide for Metabase-style SQL filters. Linked from the filter
 * bar, the top nav, and filter-related query errors.
 */
</script>

<template>
  <div class="docs">
    <article class="docs__article">
      <p class="docs__kicker">Documentation</p>
      <h1>Query filters</h1>
      <p class="docs__lede">
        Filters sit on the <strong>whole saved query</strong> — SQL, chart, and
        Python visualization share the same chips. Changing a chip re-runs the
        query. The model matches Metabase native SQL: bind variables, optional
        clauses, and field filters.
      </p>

      <nav class="docs__toc">
        <a href="#variables">Variables</a>
        <a href="#optional">Optional clauses</a>
        <a href="#field">Field filters</a>
        <a href="#dates">Dates</a>
        <a href="#add">Adding a filter</a>
        <a href="#errors">Common errors</a>
      </nav>

      <section id="variables">
        <h2>Variables (bind parameters)</h2>
        <p>
          Write <code v-pre>{{name}}</code> where a <em>value</em> belongs. Crunch
          replaces it with a driver bind — never string concatenation — so the
          value cannot inject SQL.
        </p>
        <pre v-pre>SELECT *
FROM hex.stakes
WHERE created_at >= CAST({{start_date}} AS timestamp)
  AND created_at &lt;  CAST({{end_date}} AS timestamp)</pre>
        <p>
          Use this when the same value is applied in several places (two tables,
          a calculation, a <code>CAST</code>). Type the variable as
          <strong>date (bind)</strong>, <strong>text</strong>, or
          <strong>number</strong> in filter settings.
        </p>
      </section>

      <section id="optional">
        <h2>Optional clauses</h2>
        <p>
          Wrap a predicate in <code v-pre>[[ … ]]</code>. If any variable inside
          is empty, the whole bracketed chunk is dropped.
        </p>
        <pre v-pre>SELECT * FROM orders
WHERE 1=1
  [[ AND status = {{status}} ]]
  [[ AND region = {{region}} ]]</pre>
        <p>
          Leaving a chip on “any” removes that predicate instead of binding
          <code>NULL</code>.
        </p>
      </section>

      <section id="field">
        <h2>Field filters</h2>
        <p>
          A field filter is a variable that stands in for a <em>whole SQL
          clause</em>, mapped to a column. Put it where a condition belongs —
          typically in <code>WHERE</code> — not inside <code>CAST()</code> or
          <code>=</code>.
        </p>
        <pre v-pre>SELECT COUNT(*) AS n
FROM hex.stakes
WHERE {{created}}</pre>
        <p>
          Map <code>created</code> to <code>hex.stakes.created_at</code> and pick
          a widget:
        </p>
        <ul>
          <li><strong>Date range</strong> → <code>column &gt;= start AND column &lt; end</code> (end is exclusive of the next day)</li>
          <li><strong>Single date / month</strong> → that day or calendar month</li>
          <li><strong>Category (dropdown)</strong> → <code>column = value</code> or <code>IN (…)</code> for several values</li>
          <li><strong>Contains / not equal / between</strong> → set the operator in filter settings</li>
        </ul>
        <p>
          An empty field filter becomes <code>1=1</code>, so the query still
          runs. Load dropdown choices from the mapped column with
          <em>Load values from database</em> in settings.
        </p>
        <h3>One range, two tables</h3>
        <p>
          Field filters map to <em>one</em> column. If both
          <code>hex.stakes</code> and <code>phex.stakes</code> should share a
          range, keep two <strong>date variables</strong> and reuse them:
        </p>
        <pre v-pre>WHERE hex.stakes.created_at &gt;= CAST({{start_date}} AS timestamp)
  AND phex.stakes.created_at &gt;= CAST({{start_date}} AS timestamp)</pre>
      </section>

      <section id="dates">
        <h2>Dates</h2>
        <p>
          Date chips send real date objects to Postgres (not ISO strings). That
          is required for asyncpg — <code>CAST('2026-01-01' AS timestamp)</code>
          as a bind still fails; the bind itself must be a date.
        </p>
        <ul>
          <li><strong>Date variable</strong> — one instant: Today, Yesterday, Start of month, or a calendar date.</li>
          <li><strong>Date-range field filter</strong> — Last 7 / 30 / 90 days, this month, this year, or From–To.</li>
        </ul>
        <p>
          Relative tokens such as <code>this_month</code> and
          <code>last_7_days</code> are resolved when the query runs.
        </p>
      </section>

      <section id="add">
        <h2>Adding a filter</h2>
        <ol>
          <li>On any saved query (SQL, chart, or Python tab), click <strong>+ Filter</strong>.</li>
          <li>Choose a type. Field filters ask for a mapped column like <code>schema.table.column</code>.</li>
          <li>Crunch inserts <code v-pre>{{name}}</code> (or an optional <code v-pre>[[ AND col = {{name}} ]]</code> for variables) at the cursor in SQL.</li>
          <li>Open ⚙ on the chip to set the widget, operator, defaults, and dropdown values.</li>
        </ol>
        <p>
          The filter bar stays visible when you switch to the visualization or
          collapse the editor, so you can slice the chart without opening SQL.
        </p>
      </section>

      <section id="errors">
        <h2>Common errors</h2>
        <dl>
          <dt><code>expected a datetime.date … got 'str'</code></dt>
          <dd>
            A date bind was sent as text. Set the chip type to
            <strong>date (bind)</strong>. Names like <code>start_date</code>
            are detected automatically.
          </dd>
          <dt><code>Field filter has no mapped column</code></dt>
          <dd>
            Open ⚙ and set <strong>Mapped column</strong> to
            <code>schema.table.column</code>.
          </dd>
          <dt><code>Invalid field filter column</code></dt>
          <dd>
            Only letters, digits, underscores, and quoted identifiers are
            allowed. Use <code>hex.stakes.created_at</code>, not SQL expressions.
          </dd>
          <dt>Syntax error around <code>CAST(hex.stakes.created_at &gt;= …</code></dt>
          <dd>
            A field filter was placed where a <em>value</em> belongs. Use
            <code v-pre>WHERE {{created}}</code>, or a date <em>variable</em>
            inside <code v-pre>CAST({{start_date}} AS timestamp)</code>.
          </dd>
        </dl>
      </section>
    </article>
  </div>
</template>

<style scoped>
.docs {
  height: 100%;
  overflow: auto;
  background: var(--bg);
}
.docs__article {
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 28px 64px;
}
.docs__kicker {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
}
h1 {
  margin: 0 0 12px;
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 32px;
  letter-spacing: -0.02em;
}
.docs__lede {
  font-size: 16px;
  line-height: 1.55;
  color: var(--fg-muted);
  margin: 0 0 20px;
}
.docs__toc {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin: 0 0 28px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.docs__toc a {
  font-size: 13px;
  color: var(--fg-muted);
  text-decoration: none;
}
.docs__toc a:hover { color: var(--accent); }
section { margin: 0 0 28px; }
h2 {
  margin: 0 0 10px;
  font-size: 18px;
  font-weight: 600;
}
h3 {
  margin: 16px 0 8px;
  font-size: 14px;
  font-weight: 600;
}
p, li, dd {
  font-size: 14px;
  line-height: 1.6;
  color: var(--fg);
}
ul, ol { padding-left: 1.25em; margin: 0 0 12px; }
li { margin: 0 0 6px; }
code, pre {
  font-family: var(--font-mono);
}
code {
  font-size: 12px;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  padding: 1px 5px;
  border-radius: 3px;
}
pre {
  margin: 0 0 14px;
  padding: 12px 14px;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: var(--radius-sm);
  color: var(--code-fg);
  font-size: 12px;
  line-height: 1.5;
  overflow: auto;
}
dl { margin: 0; }
dt {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--error);
  margin: 12px 0 4px;
}
dd { margin: 0 0 8px; color: var(--fg-muted); }
</style>
