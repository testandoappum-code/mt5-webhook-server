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
    // Verificar se a conta já existe usando a coluna id
    const { data: existingAccount } = await supabase
      .from('trading_accounts')
      .select('id')
      .eq('id', String(accountId))
      .maybeSingle();
    
    if (!existingAccount) {
      // Criar nova conta usando a coluna id
      const { error: insertError } = await supabase.from('trading_accounts').insert({
        id: String(accountId),
        name: account_name || `MT5 Conta ${accountId}`,
        account_number: String(account_number || accountId),
        balance: parseFloat(balance),
        broker: 'MT5'
      });
      
      if (insertError) {
        console.error('❌ Erro ao criar conta:', insertError);
      } else {
        console.log('✅ Conta criada automaticamente:', accountId);
      }
    } else {
      // Atualizar saldo da conta existente
      const { error: updateError } = await supabase
        .from('trading_accounts')
        .update({ balance: parseFloat(balance) })
        .eq('id', String(accountId));
      
      if (updateError) {
        console.error('❌ Erro ao atualizar saldo:', updateError);
      } else {
        console.log('✅ Saldo atualizado para conta:', accountId);
      }
    }
    
    // Salvar histórico de saldo
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
// WEBHOOK DAS ORDENS (MT5)
// ============================================
app.post('/webhook/order', async (req, res) => {
  console.log('📥 Ordem recebida:', req.body);
  
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }
  
  const { account_id, asset, direction, entry_price, lots, ticket } = req.body;
  
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
        opened_at: new Date().toISOString().split('T')[0],
        status: 'Aberta',
        source: 'mt5',
        mt5_ticket: ticket || null
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, operation });
  } catch (err) {
    console.error('Erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
