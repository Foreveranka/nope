import { MAX_BYTES, parseCSV } from './csv-input.mjs';
import { parseRecipeColumn, applyRecipeOutput } from './recipe-csv.mjs';
import { prepareRecipe, decodeRecipe } from './recipe-client.mjs';
import { referenceApply, estimateRecipe } from './recipe-core.mjs';

// The same external module is a dedicated worker entry, keeping costly garbling
// off the UI thread without a blob worker or another asset/CSP exception.
if (typeof document === 'undefined') {
  let used = false;
  self.addEventListener('message', async event => {
    if (used) return;
    used = true;
    try {
      const { values, recipe } = event.data;
      self.postMessage({ type: 'stage', stage: 'PREPARING' });
      const { request, decoder } = await prepareRecipe(values, recipe);
      self.postMessage({ type: 'stage', stage: 'EVALUATING' });
      const response = await fetch('/api/recipe-gc', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request), credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`Uzak hesaplama tamamlanamadı (HTTP ${response.status}).`);
      const raw = await response.text();
      if (raw.length > 1024 * 1024) throw new Error('Sunucu cevabı boyut sınırını aştı.');
      self.postMessage({ type: 'stage', stage: 'VERIFYING' });
      const output = await decodeRecipe(JSON.parse(raw), decoder);
      const expected = referenceApply(values, recipe);
      if (!Array.isArray(output) || output.length !== values.length || Array.from(output).some((value, i) => value !== expected[i])) throw new Error('Şifreli sonuç seçili tarifle eşleşmiyor.');
      self.postMessage({ type: 'complete', values: output });
    } catch (error) {
      self.postMessage({ type: 'error', message: error.name === 'TimeoutError' ? 'Uzak hesaplama zaman aşımına uğradı. Yeniden deneyebilirsin.' : (error.message || 'Şifreli işlem doğrulanamadı.') });
    }
  });
} else {
  const $ = id => document.getElementById(id);
  const controls = ['recipe-type', 'preset', 'fill-enabled', 'fill-value', 'clamp-enabled', 'clamp-min', 'clamp-max', 'trim-enabled', 'text-case', 'redact-enabled'];
  const available = Boolean(globalThis.crypto?.subtle && globalThis.Worker);
  let dataset = null, filename = '', column = null, values = null, recipe = null;
  let worker = null, busy = false, epoch = 0, resultURL = null;
  const stages = {
    PREPARING: 'Tarayıcıda tek kullanımlık şifreli devre hazırlanıyor…',
    EVALUATING: 'Sunucu şifreli devreyi hesaplıyor…',
    VERIFYING: 'Sonuç tarayıcıda çözülüp seçili tarifle karşılaştırılıyor…',
  };

  function message(text, error = false) { $('message').textContent = text; $('message').dataset.error = String(error); }
  function ready() {
    $('run').disabled = !available || busy || !values || !recipe;
    $('file').disabled = busy;
    $('column').disabled = busy || !dataset;
    for (const id of controls) $(id).disabled = busy;
  }
  function clearResult() {
    if (resultURL) URL.revokeObjectURL(resultURL);
    resultURL = null;
    $('download').removeAttribute('href');
    $('download').removeAttribute('download');
    $('result').hidden = true;
    $('comparison').replaceChildren();
    $('after').replaceChildren();
  }
  function invalidate() {
    epoch++;
    worker?.terminate(); worker = null; busy = false;
    clearResult(); $('events').replaceChildren();
  }
  function renderTable(id, headers, rows, captionText, selected = null) {
    const table = $(id), caption = document.createElement('caption');
    caption.textContent = captionText; table.replaceChildren(caption);
    const head = document.createElement('thead'), body = document.createElement('tbody');
    for (const [i, row] of [headers, ...rows].entries()) {
      const tr = document.createElement('tr');
      row.forEach((cell, j) => {
        const td = document.createElement(i === 0 ? 'th' : 'td');
        td.textContent = cell;
        if (i === 0) td.scope = 'col';
        if (j === selected) td.className = 'selected';
        tr.append(td);
      });
      (i === 0 ? head : body).append(tr);
    }
    table.append(head, body);
  }
  function preview() {
    $('preview-wrap').hidden = !dataset;
    if (dataset) renderTable('preview', dataset.headers, dataset.rows, 'Önce / CSV yalnız tarayıcında', column);
    else $('preview').replaceChildren();
    $('row-count').textContent = `PUBLIC ROW COUNT / Açık satır sayısı: ${dataset ? dataset.rows.length : 'dosya bekleniyor'}.`;
  }
  function parameter(id) {
    const raw = $(id).value;
    if (!/^(?:0|[1-9]\d{0,2})$/.test(raw) || Number(raw) > 254) throw new Error('Tarif parametreleri 0–254 arasında tam sayı olmalı.');
    return Number(raw);
  }
  function readRecipe() {
    const type = $('recipe-type').value, steps = [];
    if (type === 'number') {
      if ($('fill-enabled').checked) steps.push({ op: 'fill', value: parameter('fill-value') });
      if ($('clamp-enabled').checked) {
        const min = parameter('clamp-min'), max = parameter('clamp-max');
        if (min > max) throw new Error('Alt sınır üst sınırdan büyük olamaz.');
        steps.push({ op: 'clamp', min, max });
      }
    } else {
      if ($('trim-enabled').checked) steps.push({ op: 'trim' });
      if ($('text-case').value !== 'none') steps.push({ op: $('text-case').value });
      if ($('redact-enabled').checked) steps.push({ op: 'redactDigits' });
    }
    if (!steps.length) throw new Error('En az bir temizleme adımı seç.');
    return { type, steps };
  }
  function describe(current) {
    return current.steps.map(step => ({
      fill: `Boş → ${step.value}`, clamp: `Sınır ${step.min}–${step.max}`,
      trim: 'Boşlukları temizle', lowercase: 'Küçük harf', uppercase: 'Büyük harf', redactDigits: 'Rakamları maskele',
    })[step.op]).join(' / ');
  }
  function choose() {
    values = null; recipe = null;
    column = $('column').value === '' ? null : Number($('column').value);
    try {
      recipe = readRecipe();
      $('recipe-summary').textContent = describe(recipe);
      $('recipe-public').textContent = `Açık tarif: ${JSON.stringify(recipe)}. Bu parametreler gizli değildir.`;
      if (!dataset || column === null) {
        $('validation').textContent = 'CSV dosyası ve işlenecek sütunu seç.';
        message('CSV dosyası ve işlenecek sütunu seç.');
      } else {
        values = parseRecipeColumn(dataset, column, recipe);
        const cost = estimateRecipe(recipe, values.length);
        $('validation').textContent = `${values.length} satır hazır · ${cost.gateCount} / 10.000 devre kapısı. Hiçbir satır veya sütun silinmez.`;
        message(available ? 'Tarif hazır. Şifreli hesaplamayı başlatabilirsin.' : 'Bu tarayıcı WebCrypto ve Web Worker desteklemiyor.');
      }
    } catch (error) {
      recipe = null;
      const detail = /gate budget|request budget/i.test(error.message)
        ? 'Bu tarif ve satır sayısı 10.000 kapı veya 3 MiB şifreli istek bütçesini aşıyor. Daha az satır veya daha az adım seç; özellikle boşluk temizleme daha fazla kapı kullanır.'
        : error.message;
      $('validation').textContent = detail;
      message(detail, true);
    }
    preview(); ready();
  }
  function setPresets() {
    const isText = $('recipe-type').value === 'text';
    $('number-controls').hidden = isText;
    $('text-controls').hidden = !isText;
    const presets = isText
      ? [['normalize', 'Boşlukları temizle + küçük harf'], ['uppercase', 'Boşlukları temizle + büyük harf'], ['redact', 'Boşlukları temizle + rakamları maskele']]
      : [['fill-clamp', 'Boşları doldur + alt / üst sınır'], ['fill', 'Yalnız boşları doldur'], ['clamp', 'Yalnız alt / üst sınır']];
    $('preset').replaceChildren(...presets.map(([value, label]) => new Option(label, value)));
    $('preset').value = presets[0][0]; applyPreset();
  }
  function applyPreset() {
    const preset = $('preset').value;
    if ($('recipe-type').value === 'number') {
      $('fill-enabled').checked = preset !== 'clamp';
      $('clamp-enabled').checked = preset !== 'fill';
    } else {
      $('trim-enabled').checked = true;
      $('text-case').value = preset === 'uppercase' ? 'uppercase' : preset === 'redact' ? 'none' : 'lowercase';
      $('redact-enabled').checked = preset === 'redact';
    }
  }
  $('file').addEventListener('change', async () => {
    invalidate(); const current = epoch;
    dataset = null; filename = ''; column = null; values = null;
    $('column').replaceChildren(new Option('Önce dosya seç', ''));
    $('file-info').textContent = 'Dosya adı, başlıklar ve seçmediğin hücreler sunucuya gönderilmez.';
    preview(); ready();
    try {
      const file = $('file').files[0];
      if (!file) { choose(); return; }
      if (file.size > MAX_BYTES) throw new Error('Dosya en fazla 64 KiB olabilir.');
      const bytes = await file.arrayBuffer();
      if (current !== epoch) return;
      dataset = parseCSV(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      filename = file.name;
      $('column').replaceChildren(new Option('Sütun seç', ''), ...dataset.headers.map((header, i) => new Option(header, String(i))));
      $('file-info').textContent = `${filename} · ${dataset.rows.length} satır · ${dataset.headers.length} sütun`;
      choose();
    } catch (error) {
      if (current !== epoch) return;
      dataset = null; values = null; preview(); ready(); message(`Dosya açılamadı: ${error.message}`, true);
    }
  });
  $('column').addEventListener('change', () => { invalidate(); choose(); });
  for (const id of controls) $(id).addEventListener(id.endsWith('-value') || id.startsWith('clamp-m') ? 'input' : 'change', () => {
    invalidate();
    if (id === 'recipe-type') setPresets();
    else if (id === 'preset') applyPreset();
    choose();
  });
  $('reset').addEventListener('click', () => {
    invalidate(); dataset = null; filename = ''; column = null; values = null;
    $('file').value = ''; $('column').replaceChildren(new Option('Önce dosya seç', ''));
    $('file-info').textContent = 'Dosya adı, başlıklar ve seçmediğin hücreler sunucuya gönderilmez.';
    choose();
  });
  $('run').addEventListener('click', () => {
    if (busy || !available || !values || !recipe || !dataset) return;
    invalidate(); busy = true;
    const current = epoch, selected = column, currentRecipe = structuredClone(recipe), start = performance.now();
    ready(); message(stages.PREPARING);
    try {
      worker = new Worker(new URL('./recipes.js', import.meta.url), { type: 'module' });
      const finish = () => { worker?.terminate(); worker = null; busy = false; ready(); };
      worker.addEventListener('message', event => {
        if (current !== epoch) return;
        const data = event.data;
        if (data.type === 'stage' && stages[data.stage]) {
          message(stages[data.stage]);
          const li = document.createElement('li'); li.textContent = stages[data.stage]; $('events').append(li);
        } else if (data.type === 'complete') {
          try {
            const output = applyRecipeOutput(dataset, selected, data.values, currentRecipe);
            const changed = dataset.rows.filter((row, i) => row[selected] !== output.rows[i][selected]).length;
            renderTable('comparison', ['Satır', 'Önce', 'Sonra'], dataset.rows.map((row, i) => [String(i + 1), row[selected] === '' ? '(boş)' : row[selected], output.rows[i][selected] === '' ? '(boş)' : output.rows[i][selected]]), `${dataset.headers[selected]} / seçili sütun`);
            renderTable('after', output.headers, output.rows, 'Sonra / tüm satırlar ve sütunlar', selected);
            resultURL = URL.createObjectURL(new Blob([output.csv], { type: 'text/csv;charset=utf-8' }));
            $('download').href = resultURL; $('download').download = filename.replace(/\.csv$/i, '') + '-temiz.csv';
            $('result-note').textContent = `${dataset.rows.length} satır işlendi · ${changed} hücre değişti · ${((performance.now() - start) / 1000).toFixed(2)} saniye. Referans kontrolü geçti; bağımsız yürütme ispatı değildir.`;
            $('result').hidden = false; message('Tamamlandı. Önce / sonra karşılaştırmasını inceleyebilirsin.');
          } catch (error) { clearResult(); message(error.message, true); }
          finally { finish(); }
        } else if (data.type === 'error') { message(data.message || 'Şifreli işlem tamamlanamadı.', true); finish(); }
      });
      worker.addEventListener('error', () => {
        if (current !== epoch) return;
        message('Tarayıcıdaki şifreleme işçisi çalıştırılamadı. Sonuç oluşturulmadı.', true); finish();
      });
      worker.postMessage({ values: [...values], recipe: currentRecipe });
    } catch (error) {
      worker?.terminate(); worker = null; busy = false; ready(); message(error.message, true);
    }
  });
  const exampleURL = URL.createObjectURL(new Blob(['\uFEFFkayit,etiket,puan\r\nS01,"  ALIce42  ",42\r\nS02," BoB7 ",\r\nS03," CLIENT 9 ",154\r\nS04," Plain ",100\r\n'], { type: 'text/csv;charset=utf-8' }));
  $('example').href = exampleURL; $('example').download = 'nope-tarif-ornek.csv';
  window.addEventListener('pagehide', () => { invalidate(); URL.revokeObjectURL(exampleURL); });
  choose();
}
