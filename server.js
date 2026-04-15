const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ============================================
// WEBHOOK DO SALDO (MT5) - CRIA CONTA AUTOMATICAMENTE
// ============================================
app.post('/webhook/balance', async (req, res) => {
  console.log('💰 Saldo recebido:', req.body);
  
  const { account_id, account_number, account_name, balance, equity, profit } = req.body;
  const accountId = account_id || account_number;
  
  try {
    const { data: existingAccount } = await supabase
      .from('trading_accounts')
      .select('account_number')
      .eq('account_number', String(accountId))
      .maybeSingle();
    
    if (!existingAccount) {
      const { error: insertError } = await supabase.from('trading_accounts').insert({
        account_number: String(accountId),
        name: account_name || `MT5 Conta ${accountId}`,
        nickname: account_name || `MT5 Conta ${accountId}`,
        balance: parseFloat(balance),
        broker: 'MT5'
      });
      
      if (insertError) {
        console.error('❌ Erro ao criar conta:', insertError);
      } else {
        console.log('✅ Conta criada automaticamente:', accountId);
      }
    } else {
      await supabase
        .from('trading_accounts')
        .update({ balance: parseFloat(balance) })
        .eq('account_number', String(accountId));
      
      console.log('✅ Saldo atualizado para conta:', accountId);
    }
    
    await supabase.from('account_balance').insert({
      account_id: String(accountId),
      balance: parseFloat(balance),
      equity: parseFloat(equity),
      profit: parseFloat(profit)
    });
    
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Erro geral:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// WEBHOOK DAS ORDENS (MT5) - COM METAS E STOPS
// ============================================
app.post('/webhook/order', async (req, res) => {
  console.log('📥 Ordem recebida:', req.body);
  
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }
  
  const { account_id, asset, direction, entry_price, lots, ticket, is_closed, result } = req.body;
  
  try {
    let { data: assetData } = await supabase
      .from('trading_assets')
      .select('id')
      .eq('name', asset)
      .single();
    
    if (!assetData) {
      const { data: newAsset } = await supabase
        .from('trading_assets')
        .insert({ name: asset, symbol: asset })
        .select()
        .single();
      assetData = newAsset;
    }
    
    // Salvar operação
    const { data: operation, error } = await supabase
      .from('trading_operations')
      .insert({
        account_id: String(account_id),
        asset_id: assetData.id,
        asset: asset,
        quantity: lots,
        direction: direction,
        entry_price: parseFloat(entry_price),
        lots: parseFloat(lots),
        result: result ? parseFloat(result) : null,
        status: is_closed ? 'Fechada' : 'Aberta',
        closed_at: is_closed ? new Date().toISOString().split('T')[0] : null,
        opened_at: new Date().toISOString().split('T')[0],
        source: 'mt5',
        mt5_ticket: ticket || null
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Se for uma ordem fechada, verificar metas e stops
    if (is_closed && result) {
      await verificarMetasEStops(account_id, parseFloat(result));
    }
    
    res.json({ success: true, operation });
  } catch (err) {
    console.error('Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// VERIFICAR METAS E STOPS
// ============================================
async function verificarMetasEStops(accountId, resultado) {
  const hoje = new Date().toISOString().split('T')[0];
  
  // Buscar metas ativas
  const { data: metas } = await supabase
    .from('trading_goals')
    .select('*')
    .eq('account_number', String(accountId))
    .eq('is_active', true)
    .lte('start_date', hoje)
    .gte('end_date', hoje);
  
  // Buscar stops diários
  const { data: stops } = await supabase
    .from('trading_daily_stops')
    .select('*')
    .eq('account_number', String(accountId))
    .eq('stop_date', hoje);
  
  let mensagens = [];
  
  // Atualizar metas
  if (metas && metas.length > 0) {
    for (const meta of metas) {
      const novoValor = (meta.current_amount || 0) + (resultado > 0 ? resultado : 0);
      await supabase
        .from('trading_goals')
        .update({ current_amount: novoValor })
        .eq('id', meta.id);
      
      // Verificar se atingiu a meta
      if (novoValor >= meta.target_amount && meta.current_amount < meta.target_amount) {
        mensagens.push(`🎯 META ATINGIDA! ${meta.goal_type.toUpperCase()}: R$ ${novoValor.toFixed(2)} / R$ ${meta.target_amount.toFixed(2)}`);
      }
    }
  }
  
  // Atualizar stops diários
  if (stops && stops.length > 0) {
    for (const stop of stops) {
      let novoLoss = stop.current_loss || 0;
      let novoProfit = stop.current_profit || 0;
      
      if (resultado < 0) novoLoss += Math.abs(resultado);
      if (resultado > 0) novoProfit += resultado;
      
      await supabase
        .from('trading_daily_stops')
        .update({ 
          current_loss: novoLoss,
          current_profit: novoProfit
        })
        .eq('id', stop.id);
      
      // Verificar se atingiu o stop
      if (!stop.is_stopped) {
        let deveParar = false;
        if (stop.stop_type === 'loss' && novoLoss >= stop.stop_value) {
          deveParar = true;
          mensagens.push(`🛑 STOP DE PERDA ATINGIDO! Perda total: R$ ${novoLoss.toFixed(2)}`);
        } else if (stop.stop_type === 'profit' && novoProfit >= stop.stop_value) {
          deveParar = true;
          mensagens.push(`✅ STOP DE LUCRO ATINGIDO! Lucro total: R$ ${novoProfit.toFixed(2)}`);
        } else if (stop.stop_type === 'both' && (novoLoss >= stop.stop_value || novoProfit >= stop.stop_value)) {
          deveParar = true;
          mensagens.push(`🛑 STOP ATINGIDO! Perda: R$ ${novoLoss.toFixed(2)} | Lucro: R$ ${novoProfit.toFixed(2)}`);
        }
        
        if (deveParar) {
          await supabase
            .from('trading_daily_stops')
            .update({ is_stopped: true })
            .eq('id', stop.id);
        }
      }
    }
  }
  
  // Enviar notificações
  if (mensagens.length > 0) {
    const { data: account } = await supabase
      .from('trading_accounts')
      .select('nickname, account_number')
      .eq('account_number', String(accountId))
      .single();
    
    const nomeConta = account?.nickname || account?.account_number || accountId;
    
    for (const msg of mensagens) {
      await enviarTelegram(`${msg}\n📊 Conta: ${nomeConta}`);
      
      await supabase.from('trading_notifications').insert({
        account_number: String(accountId),
        notification_type: 'goal_stop',
        message: msg
      });
    }
  }
}

// ============================================
// ENVIAR MENSAGEM PARA O TELEGRAM
// ============================================
async function enviarTelegram(mensagem) {
  const TELEGRAM_TOKEN = '8661205406:AAGHYBwzg5X5NBshGZkd5LOZdXwNglOhRz0';
  const TELEGRAM_CHAT_ID = '5942215921';
  
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(mensagem)}`;
  
  try {
    const fetch = await import('node-fetch');
    await fetch.default(url);
    console.log('📨 Notificação enviada ao Telegram');
  } catch (err) {
    console.error('Erro ao enviar Telegram:', err);
  }
}

// ============================================
// API PARA GERENCIAR METAS
// ============================================
app.post('/api/goals', async (req, res) => {
  const { account_number, goal_type, target_amount, end_date } = req.body;
  
  const { data, error } = await supabase.from('trading_goals').insert({
    account_number: String(account_number),
    goal_type: goal_type || 'daily',
    target_amount: parseFloat(target_amount),
    end_date: end_date,
    start_date: new Date().toISOString().split('T')[0]
  }).select();
  
  if (error) {
    res.status(500).json({ error: error.message });
  } else {
    res.json({ success: true, data });
  }
});

app.get('/api/goals/:account_number', async (req, res) => {
  const { data, error } = await supabase
    .from('trading_goals')
    .select('*')
    .eq('account_number', String(req.params.account_number))
    .order('created_at', { ascending: false });
  
  res.json({ data, error });
});

// ============================================
// API PARA GERENCIAR STOPS
// ============================================
app.post('/api/stops', async (req, res) => {
  const { account_number, stop_type, stop_value } = req.body;
  
  const hoje = new Date().toISOString().split('T')[0];
  
  const { data, error } = await supabase.from('trading_daily_stops').insert({
    account_number: String(account_number),
    stop_type: stop_type || 'loss',
    stop_value: parseFloat(stop_value),
    stop_date: hoje
  }).select();
  
  if (error) {
    res.status(500).json({ error: error.message });
  } else {
    res.json({ success: true, data });
  }
});

app.get('/api/stops/:account_number', async (req, res) => {
  const hoje = new Date().toISOString().split('T')[0];
  
  const { data, error } = await supabase
    .from('trading_daily_stops')
    .select('*')
    .eq('account_number', String(req.params.account_number))
    .eq('stop_date', hoje);
  
  res.json({ data, error });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
