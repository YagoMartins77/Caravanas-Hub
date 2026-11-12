-- =============================================================================
-- Caravanas Hub — 001_dominio.sql
-- Migração + seed do domínio "caravanas esportivas da Alta Paulista".
--
-- Idempotente: pode rodar várias vezes (o caravanas-service executa este arquivo
-- a cada subida). Para recriar o banco manualmente:
--   mysql -h <host> -u <user> -p <database> < db/001_dominio.sql
--
-- Observação: o marcador /*FK_USUARIO*/ é só um comentário. Na subida automática,
-- o serviço troca o tipo das colunas marcadas pelo tipo real de usuarios.id,
-- para a chave estrangeira nunca falhar por divergência INT x INT UNSIGNED.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Base de contas (já existia na versão anterior; criada aqui para quem clona)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  nome               VARCHAR(120) NOT NULL,
  email              VARCHAR(180) NOT NULL UNIQUE,
  senha_hash         VARCHAR(255) NOT NULL,
  role               VARCHAR(20)  NOT NULL DEFAULT 'passageiro',
  premium            TINYINT(1)   NOT NULL DEFAULT 0,
  stripe_customer_id VARCHAR(255) NULL,
  avatar_url         VARCHAR(500) NULL,
  criado_em          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS premium TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255) NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500) NULL;

-- Papéis do negócio: admin (organizador), motorista, passageiro.
-- O papel antigo "usuario" vira "passageiro".
ALTER TABLE usuarios MODIFY role VARCHAR(20) NOT NULL DEFAULT 'passageiro';
UPDATE usuarios SET role = 'passageiro' WHERE role NOT IN ('admin', 'motorista', 'passageiro');

CREATE TABLE IF NOT EXISTS reset_tokens (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  token      VARCHAR(64) NOT NULL,
  usuario_id INT NOT NULL /*FK_USUARIO*/,
  expira_em  DATETIME NOT NULL,
  usado      BOOLEAN NOT NULL DEFAULT FALSE,
  INDEX idx_reset_token (token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 2. Sai o domínio antigo (filmes do Tom Hanks). O histórico continua no git.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS favoritos;
DROP TABLE IF EXISTS comentarios;
ALTER TABLE usuarios DROP COLUMN IF EXISTS banner_url;

-- -----------------------------------------------------------------------------
-- 3. Domínio novo
-- -----------------------------------------------------------------------------

-- Evento esportivo (jogo, corrida ou luta). Futebol pode vir da API Futebol.
CREATE TABLE IF NOT EXISTS eventos (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  modalidade       ENUM('futebol', 'f1', 'mma') NOT NULL,
  titulo           VARCHAR(160) NOT NULL,
  competicao       VARCHAR(120) NULL,
  local_nome       VARCHAR(160) NOT NULL,
  cidade_destino   VARCHAR(120) NOT NULL,
  data_evento      DATETIME     NOT NULL,
  valor_ingresso   DECIMAL(10,2) NOT NULL DEFAULT 0,  -- repasse a preço de custo
  api_partida_id   INT NULL UNIQUE,                   -- id da partida na API Futebol
  escudo_mandante  VARCHAR(500) NULL,
  escudo_visitante VARCHAR(500) NULL,
  criado_em        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Frota própria do organizador (vans e ônibus).
CREATE TABLE IF NOT EXISTS veiculos (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  tipo         ENUM('van', 'onibus') NOT NULL,
  modelo       VARCHAR(120) NOT NULL,
  placa        VARCHAR(10)  NOT NULL UNIQUE,
  capacidade   INT NOT NULL,
  consumo_km_l DECIMAL(5,2) NOT NULL,                 -- km por litro de diesel
  foto_url     VARCHAR(500) NULL,                     -- objeto no MinIO (bucket veiculos)
  ativo        TINYINT(1) NOT NULL DEFAULT 1,
  criado_em    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A caravana: um veículo, saindo de uma cidade da Alta Paulista, para um evento.
CREATE TABLE IF NOT EXISTS caravanas (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  evento_id          INT NOT NULL,
  veiculo_id         INT NOT NULL,
  motorista_id       INT NULL /*FK_USUARIO*/,
  criado_por         INT NULL /*FK_USUARIO*/,
  cidade_saida       VARCHAR(80)  NOT NULL,
  ponto_encontro     VARCHAR(200) NOT NULL,
  data_saida         DATETIME     NOT NULL,
  distancia_km       DECIMAL(7,1) NOT NULL,           -- só ida
  preco_litro        DECIMAL(6,2) NOT NULL,
  custo_motorista    DECIMAL(10,2) NOT NULL,
  custo_pedagio      DECIMAL(10,2) NOT NULL DEFAULT 0, -- ida + volta
  margem_pct         DECIMAL(5,2) NOT NULL DEFAULT 20,
  abertura_vendas_em DATETIME     NOT NULL,           -- abertura para o Free (Pro abre antes)
  status             ENUM('aberta', 'lotada', 'cancelada', 'concluida') NOT NULL DEFAULT 'aberta',
  criado_em          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_caravana_evento    FOREIGN KEY (evento_id)    REFERENCES eventos(id),
  CONSTRAINT fk_caravana_veiculo   FOREIGN KEY (veiculo_id)   REFERENCES veiculos(id),
  CONSTRAINT fk_caravana_motorista FOREIGN KEY (motorista_id) REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT fk_caravana_criador   FOREIGN KEY (criado_por)   REFERENCES usuarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cupons de desconto do plano Pro (estilo clube de vantagens).
CREATE TABLE IF NOT EXISTS cupons (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  usuario_id   INT NOT NULL /*FK_USUARIO*/,
  codigo       VARCHAR(40) NOT NULL UNIQUE,
  desconto_pct DECIMAL(5,2) NOT NULL,                 -- aplicado só sobre a parte da viagem
  descricao    VARCHAR(160) NULL,
  validade     DATE NOT NULL,
  usado        TINYINT(1) NOT NULL DEFAULT 0,
  criado_em    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cupom_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A passagem (viagem + ingresso) comprada por um passageiro.
CREATE TABLE IF NOT EXISTS reservas (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  caravana_id     INT NOT NULL,
  usuario_id      INT NOT NULL /*FK_USUARIO*/,
  cupom_id        INT NULL,
  assento         INT NULL,                           -- NULL quando cancelada (libera o lugar)
  valor_viagem    DECIMAL(10,2) NOT NULL,
  valor_ingresso  DECIMAL(10,2) NOT NULL,
  desconto        DECIMAL(10,2) NOT NULL DEFAULT 0,
  valor_total     DECIMAL(10,2) NOT NULL,
  status          ENUM('confirmada', 'cancelada', 'embarcou') NOT NULL DEFAULT 'confirmada',
  concorre_brinde TINYINT(1) NOT NULL DEFAULT 0,      -- Pro entra no sorteio de brindes
  brinde          VARCHAR(160) NULL,
  criado_em       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reserva_assento (caravana_id, assento),
  CONSTRAINT fk_reserva_caravana FOREIGN KEY (caravana_id) REFERENCES caravanas(id) ON DELETE CASCADE,
  CONSTRAINT fk_reserva_usuario  FOREIGN KEY (usuario_id)  REFERENCES usuarios(id) ON DELETE CASCADE,
  CONSTRAINT fk_reserva_cupom    FOREIGN KEY (cupom_id)    REFERENCES cupons(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 4. Seed (ids fixos + INSERT IGNORE = não duplica ao rodar de novo)
-- -----------------------------------------------------------------------------
INSERT IGNORE INTO veiculos (id, tipo, modelo, placa, capacidade, consumo_km_l) VALUES
  (1, 'van',    'Mercedes-Benz Sprinter 416 (15 lugares)', 'CHB1A23', 15, 9.50),
  (2, 'onibus', 'Marcopolo Paradiso G7 1200 (44 lugares)', 'CHB4D56', 44, 3.20),
  (3, 'van',    'Renault Master Executiva (16 lugares)',   'CHB7G89', 16, 10.00);

INSERT IGNORE INTO eventos (id, modalidade, titulo, competicao, local_nome, cidade_destino, data_evento, valor_ingresso) VALUES
  (1, 'futebol', 'Palmeiras x Corinthians', 'Campeonato Brasileiro', 'Allianz Parque',              'São Paulo - SP', '2026-12-06 16:00:00', 180.00),
  (2, 'f1',      'Grande Prêmio de São Paulo de F1 (domingo)', 'Fórmula 1', 'Autódromo de Interlagos', 'São Paulo - SP', '2027-11-07 14:00:00', 990.00),
  (3, 'mma',     'UFC Fight Night São Paulo', 'UFC', 'Ginásio do Ibirapuera',                          'São Paulo - SP', '2027-03-20 20:00:00', 450.00),
  (4, 'futebol', 'São Paulo x Santos', 'Campeonato Paulista', 'MorumBIS',                               'São Paulo - SP', '2027-02-14 18:30:00', 120.00);

INSERT IGNORE INTO caravanas
  (id, evento_id, veiculo_id, motorista_id, cidade_saida, ponto_encontro, data_saida,
   distancia_km, preco_litro, custo_motorista, custo_pedagio, margem_pct, abertura_vendas_em, status) VALUES
  (1, 1, 2, NULL, 'Marília',    'Terminal Rodoviário de Marília',      '2026-12-06 07:00:00', 440.0, 6.29, 600.00, 260.00, 20, '2026-11-10 10:00:00', 'aberta'),
  (2, 2, 2, NULL, 'Tupã',       'Praça da Bandeira - Tupã',            '2027-11-07 03:00:00', 520.0, 6.29, 700.00, 280.00, 20, '2027-09-01 10:00:00', 'aberta'),
  (3, 3, 1, NULL, 'Adamantina', 'Posto Trevo - Rodovia SP-294',        '2027-03-20 09:00:00', 590.0, 6.29, 500.00, 300.00, 25, '2026-11-20 10:00:00', 'aberta'),
  (4, 4, 3, NULL, 'Garça',      'Estação Ferroviária de Garça',        '2027-02-14 09:30:00', 400.0, 6.29, 450.00, 220.00, 20, '2026-11-01 10:00:00', 'aberta');

