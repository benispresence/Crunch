<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '@/api/client';
const props = defineProps<{ pipelineId: number }>();
type Entry = { name: string; value: string | null; secret: boolean };
const entries = ref<Entry[]>([]);
const busy = ref(false);
const loaded = ref(false);
const message = ref('');
const error = ref('');
watch(() => props.pipelineId, async id => {
  loaded.value = false;
  try { entries.value = (await api.get<{entries: Entry[]}>(`/pipelines/${id}/environment`)).entries; loaded.value = true; }
  catch (e) { error.value = String(e); }
}, {immediate: true});
async function save() {
  busy.value = true; error.value = ''; message.value = '';
  try {
    entries.value = (await api.put<{entries: Entry[]}>(`/pipelines/${props.pipelineId}/environment`, {entries: entries.value})).entries;
    message.value = 'Variables and secrets saved.';
  } catch(e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="environment" aria-label="Variables and secrets">
    <h3>Variables &amp; Secrets</h3>
    <p>Read values in Python with <code>ctx.env["API_TOKEN"]</code>.</p>
    <p>Saved separately from the draft. Changes apply when the next job starts, including tests, retries and published versions. Version restore does not restore these values.</p>
    <p>Secrets are encrypted and never returned to this form. Exact secret values are masked in run output; avoid printing or transforming credentials.</p>
    <fieldset :disabled="busy || !loaded">
      <div v-for="(entry, i) in entries" :key="i" class="environment__row">
        <label>Name<input v-model="entry.name" :aria-label="`Variable name ${i+1}`" placeholder="API_TOKEN" :readonly="entry.secret && entry.value === null" autocomplete="off" /></label>
        <label>Type<select v-model="entry.secret" :aria-label="`Variable type ${i+1}`" :disabled="entry.value === null"><option :value="false">Variable</option><option :value="true">Secret</option></select></label>
        <label>Value<input :value="entry.value ?? ''" @input="entry.value = ($event.target as HTMLInputElement).value" :type="entry.secret ? 'password' : 'text'" :aria-label="`Variable value ${i+1}`" :placeholder="entry.value === null ? 'Saved secret — type to replace' : 'Value'" autocomplete="new-password" /></label>
        <button type="button" @click="entries.splice(i,1)">Remove</button>
      </div>
      <p v-if="!entries.length">No variables or secrets configured.</p>
      <div class="environment__actions">
        <button type="button" @click="entries.push({name:'',value:'',secret:false}); message=''">Add variable</button>
        <button type="button" @click="entries.push({name:'',value:'',secret:true}); message=''">Add secret</button>
        <button type="button" @click="save">{{ busy ? 'Saving…' : 'Save variables & secrets' }}</button>
      </div>
    </fieldset>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.environment { border: 1px solid var(--border, #ddd); padding: 20px; border-radius: 8px; margin: 20px 0; }
.environment p { font-size: 13px; line-height: 1.5; }
.environment fieldset { border: 0; padding: 0; min-width: 0; }
.environment__row { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; margin: 12px 0; }
.environment label { display: grid; gap: 6px; flex: 1; font-size: 12px; min-width: 140px; }
.environment input, .environment select, .environment button { padding: 8px; border: 1px solid var(--border, #ccc); border-radius: 5px; background: var(--bg, transparent); color: inherit; }
.environment__actions { display: flex; gap: 8px; flex-wrap: wrap; }
.environment button { cursor: pointer; }
</style>
