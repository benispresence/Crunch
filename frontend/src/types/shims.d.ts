declare module "splitpanes" {
  import type { DefineComponent } from "vue";
  export const Splitpanes: DefineComponent<Record<string, unknown>>;
  export const Pane: DefineComponent<Record<string, unknown>>;
}

declare module "plotly.js-dist-min" {
  const Plotly: {
    react(el: HTMLElement, data: unknown[], layout: Record<string, unknown>, config?: Record<string, unknown>): Promise<unknown>;
    purge(el: HTMLElement): void;
    [key: string]: unknown;
  };
  export default Plotly;
  export type Data = Record<string, unknown>;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
