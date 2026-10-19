'use strict';
// Сведения о компьютере (оборудование, диски), нагрузка и журнал действий.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { describeFsError } = require('../safe-paths');

module.exports = function registerSystemRoutes({ app, db, HW, systemStats, fmtBytes }) {
app.get('/api/hw/info', async (req, res) => {
  try {
    res.json(await HW.info(req.query.refresh === '1'));
  }
  catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/hw/live', async (req, res) => {
  try {
    res.json(await HW.live({ gpu: req.query.gpu !== '0' }));
  }
  catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/hw/disks', async (req, res) => {
  try {
    res.json(await HW.disks({ force: req.query.refresh === '1', spaceOnly: req.query.mode === 'space' }));
  }
  catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/system', (req, res) => res.json({ cpu: systemStats.getCpuPercent(), cores: os.cpus().length, memTotal: os.totalmem(), memUsed: os.totalmem() - os.freemem() }));

app.get('/api/audit', (req, res) => res.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 500').all()));



  // Выбор папки на любом диске компьютера (для рабочей папки приложения). Нужно право «files.disks».
  app.get('/api/browse', async (req, res) => {
    try {
      const requested = req.query.path || '';
      if (!requested) { // корень: обнаруженные диски и разделы
        let list = [];
        try { await HW.disks(); list = HW.mountList(); } catch { /* список дисков недоступен */ }
        if (!list.length && process.platform === 'win32') {
          for (let code = 65; code <= 90; code++) {
            const drive = String.fromCharCode(code) + ':\\';
            try { if (fs.existsSync(drive)) list.push({ mount: drive, label: '', free: null }); } catch { /* диск недоступен */ }
          }
        }
        if (!list.length) list = [{ mount: path.parse(process.cwd()).root, label: '', free: null }];
        return res.json(list.map(item => ({
          name: `${item.mount}${item.label ? '  ·  ' + item.label : ''}${item.free != null ? '  ·  свободно ' + fmtBytes(item.free) : ''}`,
          type: 'directory', path: item.mount,
        })));
      }
      const target = path.resolve(requested);
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return res.status(400).json({ error: 'Папка не найдена или диск недоступен' });
      if (HW.blocked(fs.realpathSync(target))) return res.status(400).json({ error: 'Этот системный каталог недоступен' });
      const entries = await fs.promises.readdir(target, { withFileTypes: true });
      res.json(entries.filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name, type: 'directory', path: path.join(target, entry.name) })));
    } catch (error) {
      res.status(400).json({ error: describeFsError(error) });
    }
  });

};
