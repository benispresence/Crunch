import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { applyThemeOnBoot } from "./composables/theme";
import { router } from "./router";
import "./assets/styles.css";

applyThemeOnBoot();

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");
