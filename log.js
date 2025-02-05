const TelegramBot = require('tgfancy');
const pm2 = require('pm2');
const fs = require('fs');
const path = require('path');
const CHAT_ID = process.env.CHAT_ID
require('dotenv').config();

// Configuratie
const LOG_LINES = 100; // Aantal logregels om te versturen
const INTERVAL = 1 * 60 * 60 * 1000; // 12 uur in milliseconden

// Telegram bot initialiseren
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: true});

pm2.connect((connectErr) => {
    if (connectErr) {
      console.error('PM2 connect error:', connectErr);
      process.exit(1);
    }
  
    scheduleLogCheck();
    sendLogs();
    
    bot.onText(/\/start/, (msg) => {
      bot.sendMessage(msg.chat.id, 'PM2 Log Monitor is actief!');
    });
  });
  
  async function sendLogs() {
    try {
      const logs = await getPm2ErrorLogs();
      
      if (logs.length === 0) {
        await bot.sendMessage(CHAT_ID, '✅ Geen nieuwe errors gevonden');
        return;
      }
  
      // 1. Escape HTML tekens
      const escapedLogs = logs.map(line => 
        line.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')
      );
      
      // 2. Split logs in chunks (Telegram heeft max 4096 tekens per bericht)
      const chunkSize = 3000;
      const logChunks = [];
      
      let currentChunk = '';
      for (const line of escapedLogs) {
        if (currentChunk.length + line.length > chunkSize) {
          logChunks.push(currentChunk);
          currentChunk = '';
        }
        currentChunk += line + '\n';
      }
      if (currentChunk) logChunks.push(currentChunk);
  
      // 3. Verstuur elk chunk
      for (const [index, chunk] of logChunks.entries()) {
        await bot.sendMessage(CHAT_ID, `<pre>${chunk}</pre>`, {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
        // Wacht 1 seconde tussen berichten
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } catch (error) {
      console.error('Error:', error);
      await bot.sendMessage(CHAT_ID, `❌ Fout: ${error.message.slice(0, 3000)}`);
    }
  }
  
  async function getPm2ErrorLogs() {
    return new Promise((resolve, reject) => {
      pm2.list((err, processes) => {
        if (err) return reject(err);
        
        const logPromises = processes.map(proc => {
          return new Promise((res) => {
            const logPath = proc.pm2_env.pm_err_log_path;
            if (!fs.existsSync(logPath)) return res([]);
            
            fs.readFile(logPath, 'utf8', (readErr, data) => {
              if (readErr) return res([]);
              const lines = data.split('\n')
                .filter(line => line.toLowerCase().includes('error'))
                .slice(-LOG_LINES);
              res(lines);
            });
          });
        });
  
        Promise.all(logPromises).then(results => {
          resolve([].concat(...results).filter(l => l.trim()));
        });
      });
    });
  }
  
  function scheduleLogCheck() {
    setInterval(() => {
      sendLogs();
    }, INTERVAL);
  }
  
  process.on('SIGINT', () => {
    pm2.disconnect();
    process.exit();
  });
  const stateFile = 'log-state.json';

  // Laad de laatste positie
  function loadLogState() {
    try {
      return require(`./${stateFile}`);
    } catch {
      return {};
    }
  }
  
  // Sla de laatste positie op
  function saveLogState(state) {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  
  async function getPm2ErrorLogs() {
    const state = loadLogState();
    const newState = {};
  
    return new Promise((resolve, reject) => {
      pm2.list((err, processes) => {
        if (err) return reject(err);
  
        const logPromises = processes.map(proc => {
          return new Promise(res => {
            const logPath = proc.pm2_env.pm_err_log_path;
            if (!fs.existsSync(logPath)) return res([]);
  
            const stats = fs.statSync(logPath);
            const fileSize = stats.size;
            const inode = stats.ino; // Unieke file identifier
  
            // Controleer of het bestand is gewijzigd
            if (state[logPath]?.inode !== inode) {
              newState[logPath] = { position: 0, inode };
              return res([]);
            }
  
            const lastPosition = state[logPath].position || 0;
            const readStream = fs.createReadStream(logPath, {
              start: lastPosition,
              encoding: 'utf8'
            });
  
            let newData = '';
            readStream.on('data', chunk => newData += chunk);
            readStream.on('end', () => {
              const lines = newData.split('\n')
                .filter(line => line.toLowerCase().includes('error'));
              
              newState[logPath] = {
                position: lastPosition + Buffer.byteLength(newData),
                inode
              };
              
              res(lines);
            });
          });
        });
  
        Promise.all(logPromises).then(results => {
          saveLogState(newState);
          resolve([].concat(...results).filter(l => l.trim()));
        });
      });
    });
  }