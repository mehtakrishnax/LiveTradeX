/* app.js
     frontend behaviour:
     -connects to server endpoint/api/ws authorize to get authorized ws url for your broker 
     -connects to the ws,subscribes to instrument ticks.This ui expects the server /broker to ws to send json ticks like:
     {symbol:"RELIANCE",timestamp:1234567890,last_price:2500.5,bid:2500,ask:2500.8,volume:1234}
     -if no ws is avialable, a demo simulator dends ticks so you can see the ui.
     -order placemnet:calls post/api/order with jsonbody
     (tradingsymbol,quantity,transaction_type,order_type,product)-your server should place the order with the broker.
     */
(() => {
    //DOM refs
    const connectBtn = document.getElementById('connectBtn');
    const wsStatus = document.getElementById('wsStatus');
    const latencyEl = document.getElementById('latency');
    const ltpEl = document.getElementById('ltp');
    const symDisplay = document.getElementById('symDisplay');
    const deltaEl = document.getElementById('delta');
    const bidEl = document.getElementById('bid');
    const askEl = document.getElementById('ask');
    const volEl = document.getElementById('vol');
    const ticksList = document.getElementById('ticksList');
    const symbolInput = document.getElementById('symbolInput');
    const spark = document.getElementById('spark');
    const buyBtn = document.getElementById('buyBtn');
    const sellBtn = document.getElementById('sellBtn');
    const ordersEl = document.getElementById('orders');
    const rttEl = document.getElementById('rtt');
    const stimeEl = document.getElementById('stime');
    let ws = null;
    let socketOpenAt = 0;
    let lastTick = null;
    let sparkData = [];
    const MAX_SPARK = 60;
    const orders = [];
    let demoMode = false;

    // canvas sparkline
    const ctx = spark.getContext('2d');
    function drawSpark() {
        const w = spark.width = spark.clientWidth * devicePixelRatio;
        const h = spark.height = spark.clientHeight * devicePixelRatio;
        ctx.clearRect(0, 0, w, h);
        if (sparkData.length === 0) return;
        const min = Math.min(...sparkData);
        const max = Math.max(...sparkData);
        const range = Math.max(1, max - min);
        ctx.lineWidth = 2 * devicePixelRatio;
        ctx.beginPath();
        for (let i = 0; i < sparkData.length; i++) {
            const x = (i / (MAX_SPARK - 1)) * w;
            const y = h - ((sparkData[i] - min) / range) * h;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        // gradient stroke
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, '#7c5cff');
        grad.addColorStop(1, '#00d4ff');
        ctx.strokeStyle = grad;
        ctx.stroke();
    }

    function pushSpark(val) {
        if (typeof val !== 'number' || !isFinite(val)) return;
        sparkData.push(val);
        if (sparkData.length > MAX_SPARK) sparkData.shift();
        drawSpark();
    }

    // update ticks list
    function addTick(t) {
        const item = document.createElement('div');
        item.className = 'tick';
        const time = new Date(t.timestamp || Date.now()).toLocaleTimeString();
        item.innerHTML = `<div>${time} <small class="muted">${t.symbol || t.tradingsymbol || ''}</small></div><div><strong>${(t.last_price || t.ltp || '-')}</strong></div>`;
        ticksList.prepend(item);
        // keep last 80
        while (ticksList.children.length > 80) ticksList.removeChild(ticksList.lastChild);
    }

    // process incoming tick object (normalize possible formats)
    function handleTick(raw) {
        if (!raw) return;
        // raw can be an array for some brokers; normalize to object
        let tick = raw;
        if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object') tick = raw[0];
        // sample expected shape: {symbol, last_price, bid, ask, volume, timestamp}
        const ltp = tick.last_price || tick.ltp || tick.lp || tick.price;
        const bid = tick.bid || tick.depth?.bid || '-';
        const ask = tick.ask || tick.depth?.ask || '-';
        const vol = tick.volume || tick.total_traded_volume || tick.vol || '-';
        const symbol = tick.symbol || tick.tradingsymbol || (symbolInput && symbolInput.value) || 'SYM';

        // UI updates
        symDisplay.textContent = symbol;
        ltpEl.textContent = ltp ? Number(ltp).toFixed(2) : '—';
        bidEl.textContent = bid || '—';
        askEl.textContent = ask || '—';
        volEl.textContent = vol || '—';

        // delta
        if (lastTick && lastTick.last_price) {
            const prev = Number(lastTick.last_price);
            const now = Number(ltp);
            const diff = now - prev;
            const pct = prev ? (diff / prev * 100) : 0;
            deltaEl.textContent = `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
            deltaEl.style.color = diff >= 0 ? '#8cffb9' : '#ff8b8b';
        }

        lastTick = { last_price: ltp };

        // spark and tick list
        if (typeof ltp === 'number' || !isNaN(Number(ltp))) {
            pushSpark(Number(ltp));
        }
        addTick({ symbol, last_price: ltp, timestamp: tick.timestamp || Date.now() });
    }

    // attempt to connect to server-provided WS
    async function connectToBrokerWS() {
        wsStatus.textContent = 'connecting...';
        try {
            // ask your server for an authorized WS URL
            const r = await fetch('/api/ws/authorize');
            const j = await r.json();
            if (!j.ok || !j.wsUrl) {
                console.warn('No wsUrl from server, switching to demo');
                wsStatus.textContent = 'no server ws (demo mode)';
                startDemoTicks();
                demoMode = true;
                return;
            }
            const url = j.wsUrl;
            // open websocket
            ws = new WebSocket(url);
            ws.binaryType = 'arraybuffer';
            ws.onopen = () => {
                socketOpenAt = performance.now();
                wsStatus.textContent = 'connected';
                latencyEl.textContent = '—';
                // If your broker requires a subscription message, send it here.
                // Example (Kite): ws.send(JSON.stringify({a: "subscribe", v: [instrument_token]}))
                // For demo, we'll not send subscription and accept ticks server sends.
            };
            ws.onmessage = (ev) => {
                // measure latency as simple RTT for message (not perfect)
                const receivedAt = performance.now();
                try {
                    const dataText = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
                    const payload = JSON.parse(dataText);
                    // if server sends heartbeat {type:'hb'} ignore
                    if (payload.type === 'hb') {
                        latencyEl.textContent = Math.round(performance.now() - socketOpenAt);
                        return;
                    }
                    handleTick(payload);
                } catch (e) {
                    // binary or unknown format — try simple parse
                    // If your broker sends array of ticks (kite gives arrays), pass array into handleTick
                    try {
                        const arr = JSON.parse(new TextDecoder().decode(ev.data));
                        handleTick(arr);
                    } catch (err) {
                        console.error('unparsed ws message', err);
                    }
                }
            };
            ws.onclose = () => {
                wsStatus.textContent = 'closed';
                // try reconnect with exponential backoff
                setTimeout(() => connectToBrokerWS(), 2000);
            };
            ws.onerror = (e) => {
                console.error('WS error', e);
                wsStatus.textContent = 'error';
                // fallback to demo
                startDemoTicks();
                demoMode = true;
            };
        } catch (err) {
            console.error('connect error', err);
            wsStatus.textContent = 'error';
            startDemoTicks();
            demoMode = true;
        }
    }

    // demo tick simulator (nice to have so the UI looks alive out-of-the-box)
    let demoTimer = null;
    function startDemoTicks() {
        if (demoTimer) return;
        wsStatus.textContent = 'demo (simulated ticks)';
        let price = 2500 + Math.random() * 80;
        demoTimer = setInterval(() => {
            const change = (Math.random() - 0.45) * (Math.random() * 6);
            price = Math.max(10, price + change);
            const tick = {
                symbol: symbolInput.value || 'RELIANCE',
                last_price: Number(price.toFixed(2)),
                bid: Number((price - 0.6).toFixed(2)),
                ask: Number((price + 0.6).toFixed(2)),
                volume: Math.floor(Math.random() * 500 + 30),
                timestamp: Date.now()
            };
            handleTick(tick);
            // server time display
            stimeEl.textContent = new Date().toLocaleTimeString();
        }, 700);
    }
    function stopDemo() {
        if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
    }

    // order placement
    async function placeOrder(side) {
        const symbol = symbolInput.value.trim() || 'RELIANCE';
        const qty = 1;
        const product = document.getElementById('product').value || 'CNC';
        const order_type = 'MARKET';
        const body = { tradingsymbol: symbol, quantity: qty, transaction_type: side, order_type, product };
        try {
            const t0 = performance.now();
            const res = await fetch('/api/order', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
            });
            const t1 = performance.now();
            const j = await res.json();
            const rtt = Math.round(t1 - t0);
            rttEl.textContent = `${rtt} ms`;
            // display
            const id = 'O' + Math.random().toString(36).slice(2, 9);
            const ord = { id, symbol, side, qty, status: j.ok ? 'ACK' : 'REJECT', raw: j };
            orders.unshift(ord);
            renderOrders();
        } catch (err) {
            console.error('order error', err);
            const id = 'O' + Math.random().toString(36).slice(2, 9);
            const ord = { id, symbol, side, qty, status: 'ERROR', raw: err.toString() };
            orders.unshift(ord);
            renderOrders();
        }
    }
    function renderOrders() {
        ordersEl.innerHTML = '';
        for (const o of orders.slice(0, 40)) {
            const d = document.createElement('div');
            d.style.padding = '8px';
            d.style.borderBottom = '1px dashed rgba(255,255,255,0.03)';
            d.innerHTML = `<div style="display:flex;justify-content:space-between"><div><strong>${o.symbol}</strong> <small class="muted">${o.side}</small></div><div>${o.status}</div></div><div style="font-size:12px;margin-top:6px;color:var(--muted)">${new Date().toLocaleTimeString()}</div>`;
            ordersEl.appendChild(d);
        }
    }

    // wire UI
    connectBtn.addEventListener('click', async (e) => {
        // this should redirect to your server's broker OAuth login if you want the user to authorize
        // example: window.location = '/api/zerodha/login';
        // but we also attempt to connect to WS to receive ticks if server has saved a token
        connectBtn.disabled = true;
        connectToBrokerWS().finally(() => connectBtn.disabled = false);
    });

    buyBtn.addEventListener('click', () => placeOrder('BUY'));
    sellBtn.addEventListener('click', () => placeOrder('SELL'));
    symbolInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); symDisplay.textContent = symbolInput.value; }
    });

    // initial demo connect so it looks shiny on open
    startDemoTicks();

    // animated tiny heartbeat for WS status
    setInterval(() => {
        const s = wsStatus.textContent;
        const el = wsStatus;
        if (s && s.includes('connected')) el.style.color = '#7cffb6';
        else if (s && s.includes('demo')) el.style.color = '#ffd36b';
        else el.style.color = 'var(--muted)';
    }, 1000);

    // responsive redraw
    window.addEventListener('resize', () => drawSpark());
})();

