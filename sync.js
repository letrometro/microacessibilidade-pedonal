/* ==========================================================================
   sync.js — sincronização do Microacessibilidades com Supabase.

   Local-first: a UI nunca espera pela rede. Este módulo envolve Store.load()
   e Store.save() (ver README, secção "Onde estão os dados hoje"):
     - Store.load(): devolve sempre os dados locais primeiro. Sync.init()
       é chamado à parte para ir buscar alterações remotas em segundo plano.
     - Store.save(): grava local (como sempre) e só depois tenta enviar para
       o Supabase; se falhar ou estiver offline, fica em fila e é reenviado
       quando a ligação voltar (evento "online").

   Sem chaves configuradas abaixo, a app funciona 100% offline/local e a
   fila de sincronização fica simplesmente à espera — nada bloqueia nem
   falha de forma visível para quem usa a app.

   Nota: publicada no GitHub Pages, esta app fica na mesma origem que outras
   páginas de projeto do mesmo utilizador (ex.: username.github.io/outra-app/
   — o localStorage é por origem, não por caminho). Por isso usa a sua
   própria tabela/bucket no Supabase e as suas próprias chaves em localStorage
   (todas prefixadas com "pedonal_"), para não misturar dados com outras apps.
   ========================================================================== */
(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // Configuração — preencher com os dados do projeto Supabase
  // (Project Settings → API). A anon key é pública por design: a segurança
  // fica a cargo das políticas RLS definidas em schema-pedonal.sql.
  // ---------------------------------------------------------------------
  const CONFIG = {
    url: "https://mmmuoqubzxgnqauvssbi.supabase.co",
    anonKey: "sb_publishable_As8XsV2Ie0fVClhMkD4YpQ_jHOE6LVR",
    table: "barreiras_pedonais",
    bucket: "fotos-pedonal",
  };

  const LS_EQUIPA = "pedonal_sync_equipa";
  const LS_LAST_SYNC_PREFIX = "pedonal_sync_last_at_"; // + equipa
  const LS_QUEUE = "pedonal_sync_queue";
  const LS_KNOWN = "pedonal_sync_known"; // {id: atualizado(ms)} do último estado confirmado

  let client = null;
  let localRecords = [];
  let origSave = null; // Store.save original (grava local sem passar pelo diff/push)
  let onChangeCb = null;
  let onStatusCb = null;
  const uploading = new Set();

  function configured() {
    return !!(CONFIG.url && CONFIG.anonKey);
  }

  function getClient() {
    if (client) return client;
    if (!configured() || typeof supabase === "undefined") return null;
    client = supabase.createClient(CONFIG.url, CONFIG.anonKey, {
      auth: { persistSession: false },
    });
    return client;
  }

  function setStatus(s) {
    if (onStatusCb) {
      try {
        onStatusCb(s);
      } catch (e) {}
    }
  }

  // ---------------------------------------------------------------------
  // Código de equipa (partilha simples, sem contas — ver README)
  // ---------------------------------------------------------------------
  function getEquipa() {
    return localStorage.getItem(LS_EQUIPA) || "default";
  }
  function setEquipa(v) {
    const val = ((v || "") + "").trim() || "default";
    localStorage.setItem(LS_EQUIPA, val);
    pull(); // nova equipa → puxa o histórico completo dela
    return val;
  }

  // ---------------------------------------------------------------------
  // Fila offline (ids pendentes de envio) e snapshot conhecido
  // ---------------------------------------------------------------------
  function loadJSON(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJSON(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }
  function loadQueue() {
    return loadJSON(LS_QUEUE, []);
  }
  function enqueue(id) {
    const q = loadQueue();
    if (!q.includes(id)) {
      q.push(id);
      saveJSON(LS_QUEUE, q);
    }
  }
  function dequeue(id) {
    saveJSON(
      LS_QUEUE,
      loadQueue().filter((x) => x !== id)
    );
  }
  function loadKnown() {
    return loadJSON(LS_KNOWN, {});
  }
  function saveKnown(map) {
    saveJSON(LS_KNOWN, map);
  }
  function snapshot(records) {
    const m = {};
    records.forEach((r) => {
      m[r.id] = r.atualizado || 0;
    });
    return m;
  }

  function toISO(ms) {
    return new Date(ms || Date.now()).toISOString();
  }
  function toMs(iso) {
    return new Date(iso).getTime();
  }

  // A foto nunca viaja em base64 para o Supabase — só o foto_url (ver Storage).
  function sanitize(record) {
    const clone = JSON.parse(JSON.stringify(record));
    delete clone.foto;
    return clone;
  }

  // ---------------------------------------------------------------------
  // Pull: linhas alteradas desde o último sync desta equipa; merge por id
  // com last-write-wins pelo campo "atualizado". Tombstones (eliminado)
  // removem o registo localmente em todos os dispositivos.
  // ---------------------------------------------------------------------
  async function pull() {
    const c = getClient();
    if (!c) {
      setStatus("unconfigured");
      return;
    }
    if (!navigator.onLine) {
      setStatus("offline");
      return;
    }
    setStatus("syncing");
    try {
      const equipa = getEquipa();
      const cursorKey = LS_LAST_SYNC_PREFIX + equipa;
      const since = localStorage.getItem(cursorKey);
      let query = c
        .from(CONFIG.table)
        .select("id,dados,atualizado,eliminado")
        .eq("equipa", equipa)
        .order("atualizado", { ascending: true });
      if (since) query = query.gt("atualizado", since);
      const { data, error } = await query;
      if (error) throw error;
      if (data && data.length) {
        mergeRemote(data);
        localStorage.setItem(cursorKey, data[data.length - 1].atualizado);
      }
      setStatus("idle");
    } catch (e) {
      console.warn("[sync] pull falhou:", e);
      setStatus("error");
    }
  }

  function mergeRemote(rows) {
    const known = loadKnown();
    let changed = false;
    rows.forEach((row) => {
      const remoteMs = toMs(row.atualizado);
      const idx = localRecords.findIndex((r) => r.id === row.id);
      if (row.eliminado) {
        if (idx >= 0) {
          localRecords.splice(idx, 1);
          changed = true;
        }
        delete known[row.id];
        return;
      }
      const remoteRec = Object.assign({}, row.dados, { id: row.id, atualizado: remoteMs });
      if (idx < 0) {
        localRecords.push(remoteRec);
        changed = true;
      } else if ((localRecords[idx].atualizado || 0) < remoteMs) {
        localRecords[idx] = remoteRec;
        changed = true;
      }
      known[row.id] = remoteMs;
    });
    saveKnown(known);
    if (changed) {
      if (origSave) origSave(localRecords);
      if (onChangeCb) onChangeCb(localRecords.slice());
    }
  }

  // ---------------------------------------------------------------------
  // Push: upsert por id. Registos que desapareceram localmente (eliminados)
  // são enviados como tombstone (eliminado: true) para apagar em todo lado.
  // ---------------------------------------------------------------------
  async function pushOne(id) {
    const c = getClient();
    if (!c) return false;
    const equipa = getEquipa();
    const record = localRecords.find((r) => r.id === id);
    const row = record
      ? {
          id,
          equipa,
          dados: sanitize(record),
          atualizado: toISO(record.atualizado || Date.now()),
          eliminado: false,
        }
      : { id, equipa, dados: {}, atualizado: toISO(Date.now()), eliminado: true };
    const { error } = await c.from(CONFIG.table).upsert(row);
    if (error) {
      console.warn("[sync] push falhou:", id, error);
      return false;
    }
    const known = loadKnown();
    known[id] = toMs(row.atualizado);
    saveKnown(known);
    return true;
  }

  async function flushQueue() {
    const c = getClient();
    if (!c || !navigator.onLine) return;
    const queue = loadQueue();
    if (!queue.length) return;
    setStatus("syncing");
    for (const id of queue) {
      const ok = await pushOne(id);
      if (ok) dequeue(id);
    }
    setStatus(loadQueue().length ? "error" : "idle");
  }

  // Compara o novo estado de records com o último "known" para decidir o
  // que enfileirar: criados/alterados (atualizado mais recente) e
  // desaparecidos (→ tombstone).
  function diffAndQueue(newRecords) {
    const known = loadKnown();
    const prevIds = Object.keys(known);
    const newIds = new Set();
    newRecords.forEach((r) => {
      newIds.add(r.id);
      if (known[r.id] === undefined || (r.atualizado || 0) > known[r.id]) {
        enqueue(r.id);
      }
    });
    prevIds.forEach((id) => {
      if (!newIds.has(id)) enqueue(id);
    });
  }

  // ---------------------------------------------------------------------
  // Fotografias → Supabase Storage (nunca em base64 nas linhas)
  // ---------------------------------------------------------------------
  async function uploadPhoto(id, dataUrl) {
    const c = getClient();
    if (!c || !dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const path = getEquipa() + "/" + id + ".jpg";
      const { error } = await c.storage
        .from(CONFIG.bucket)
        .upload(path, blob, { contentType: "image/jpeg", upsert: true });
      if (error) throw error;
      const { data } = c.storage.from(CONFIG.bucket).getPublicUrl(path);
      return (data && data.publicUrl) || null;
    } catch (e) {
      console.warn("[sync] upload de foto falhou:", e);
      return null;
    }
  }

  function schedulePhotoUpload(record) {
    if (!record || !record.foto || typeof record.foto !== "string" || !record.foto.startsWith("data:")) return;
    if (record.foto_url) return; // já enviada; handlePhoto()/removePhoto() limpam foto_url quando muda
    if (uploading.has(record.id)) return;
    uploading.add(record.id);
    uploadPhoto(record.id, record.foto).then((url) => {
      uploading.delete(record.id);
      if (!url) return;
      const idx = localRecords.findIndex((r) => r.id === record.id);
      if (idx < 0) return; // registo foi eliminado entretanto
      localRecords[idx].foto_url = url;
      localRecords[idx].foto = null; // já está na nuvem — liberta o espaço local (base64)
      if (origSave) origSave(localRecords);
      enqueue(record.id);
      flushQueue().catch(() => {});
    });
  }

  // ---------------------------------------------------------------------
  // Integração com Store (único ponto de contacto pedido pelo README)
  // ---------------------------------------------------------------------
  function wrapStore(Store) {
    const load = Store.load.bind(Store);
    const save = Store.save.bind(Store);
    origSave = save;

    Store.load = async function () {
      const data = await load();
      // rede de segurança: liberta base64 de fotos que já ficaram com foto_url
      // (ex.: app fechada entre o envio e a limpeza local em schedulePhotoUpload)
      let trimmed = false;
      data.forEach((r) => {
        if (r.foto && r.foto_url) { r.foto = null; trimmed = true; }
      });
      if (trimmed) origSave(data);
      localRecords = data;
      saveKnown(snapshot(data));
      return data;
    };

    Store.save = async function (data) {
      await save(data); // grava local primeiro — nunca bloqueia por causa da rede
      localRecords = data;
      data.forEach(schedulePhotoUpload);
      diffAndQueue(data);
      flushQueue().catch(() => {});
    };

    return Store;
  }

  // ---------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------
  function init(opts) {
    opts = opts || {};
    onChangeCb = opts.onChange || null;
    onStatusCb = opts.onStatus || null;
    if (opts.records) localRecords = opts.records;
    if (!configured()) {
      setStatus("unconfigured");
      return;
    }
    pull();
    flushQueue();
    localRecords.forEach(schedulePhotoUpload); // envia/limpa fotos antigas por sincronizar (ver README)
    window.addEventListener("online", () => {
      pull();
      flushQueue();
      localRecords.forEach(schedulePhotoUpload);
    });
    window.addEventListener("offline", () => setStatus("offline"));
  }

  global.Sync = {
    init,
    wrapStore,
    getEquipa,
    setEquipa,
    uploadPhoto,
    get configured() {
      return configured();
    },
  };
})(window);
