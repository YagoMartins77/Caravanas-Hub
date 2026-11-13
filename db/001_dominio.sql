-- db/001_dominio.sql
-- Migração do domínio "Tom Hanks" (filmes) para o domínio "Caravana's Hub".
-- Remove as tabelas específicas do catálogo de filmes e cria as tabelas do novo negócio.
-- Requer MariaDB 10.2.1+ (suporte a CHECK constraints de fato aplicadas).

-- ============================================================================
-- 1. Tabelas que NÃO mudam: reset_tokens e sessions continuam servindo
--    recuperação de senha e sessão HTTP exatamente como antes.
-- ============================================================================
CREATE TABLE IF NOT EXISTS reset_tokens (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    token       VARCHAR(64) NOT NULL,
    usuario_id  INT NOT NULL,
    expira_em   DATETIME NOT NULL,
    usado       BOOLEAN NOT NULL DEFAULT FALSE,
    INDEX idx_reset_token (token)
) ENGINE=InnoDB;

-- ============================================================================
-- 2. Remove as tabelas específicas do domínio antigo (filmes)
-- ============================================================================
DROP TABLE IF EXISTS comentarios;
DROP TABLE IF EXISTS favoritos;

-- ============================================================================
-- 3. contas — identidade única de login (substitui a antiga "usuarios")
-- ============================================================================
CREATE TABLE IF NOT EXISTS contas (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    nome            VARCHAR(150) NOT NULL,
    email           VARCHAR(190) NOT NULL UNIQUE,
    senha_hash      VARCHAR(255) NOT NULL,
    papel           ENUM('passageiro', 'organizador', 'admin') NOT NULL DEFAULT 'passageiro',
    time_torcida    VARCHAR(100) NULL,
    avatar_url      VARCHAR(500) NULL,
    criado_em       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

ALTER TABLE contas ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500) NULL;

-- ============================================================================
-- 4. usuarios_free — passageiros no plano gratuito
-- ============================================================================
CREATE TABLE IF NOT EXISTS usuarios_free (
    conta_id        INT PRIMARY KEY,
    desde           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_free_conta FOREIGN KEY (conta_id) REFERENCES contas(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================================
-- 5. usuarios_premium — assinantes do plano Pro (Stripe)
-- ============================================================================
CREATE TABLE IF NOT EXISTS usuarios_premium (
    conta_id              INT PRIMARY KEY,
    stripe_customer_id    VARCHAR(255) NULL,
    data_assinatura       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ativo                 TINYINT(1) NOT NULL DEFAULT 1,
    CONSTRAINT fk_premium_conta FOREIGN KEY (conta_id) REFERENCES contas(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================================
-- 6. organizadores — responsável pela van/ônibus de uma caravana
-- ============================================================================
CREATE TABLE IF NOT EXISTS organizadores (
    conta_id            INT PRIMARY KEY,
    documento           VARCHAR(30) NULL,     -- CPF ou CNPJ
    descricao_frota     VARCHAR(255) NULL,    -- ex.: "Van Sprinter, 16 lugares"
    contato_whatsapp    VARCHAR(20) NULL,
    CONSTRAINT fk_organizador_conta FOREIGN KEY (conta_id) REFERENCES contas(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================================
-- 7. eventos — jogo, corrida (F1) ou luta (MMA)
--
--    Regra "só admin cadastra corrida": reforçada no backend (RBAC).
--    Regra "só uma corrida no Brasil por ano": reforçada no trigger abaixo.
-- ============================================================================
CREATE TABLE IF NOT EXISTS eventos (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    tipo             ENUM('futebol', 'corrida', 'mma') NOT NULL,
    nome             VARCHAR(150) NOT NULL,
    local            VARCHAR(150) NOT NULL,
    pais             VARCHAR(80) NOT NULL DEFAULT 'Brasil',
    data_evento      DATE NOT NULL,
    criado_por       INT NOT NULL,
    valor_ingresso   DECIMAL(10,2) NOT NULL DEFAULT 0,
    api_partida_id   INT NULL UNIQUE,
    escudo_mandante  VARCHAR(500) NULL,
    escudo_visitante VARCHAR(500) NULL,
    criado_em        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_evento_criador FOREIGN KEY (criado_por) REFERENCES contas(id)
) ENGINE=InnoDB;

ALTER TABLE eventos ADD COLUMN IF NOT EXISTS valor_ingresso DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS api_partida_id INT NULL;
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS escudo_mandante VARCHAR(500) NULL;
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS escudo_visitante VARCHAR(500) NULL;

DELIMITER $$
CREATE TRIGGER IF NOT EXISTS trg_corrida_brasil_unica
BEFORE INSERT ON eventos
FOR EACH ROW
BEGIN
    DECLARE qtd INT;
    IF NEW.tipo = 'corrida' AND NEW.pais = 'Brasil' THEN
        SELECT COUNT(*) INTO qtd
        FROM eventos
        WHERE tipo = 'corrida'
          AND pais = 'Brasil'
          AND YEAR(data_evento) = YEAR(NEW.data_evento);
        IF qtd > 0 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Já existe uma corrida cadastrada no Brasil para este ano.';
        END IF;
    END IF;
END$$
DELIMITER ;

-- ============================================================================
-- 8. caravanas — uma viagem específica para um evento
-- ============================================================================
CREATE TABLE IF NOT EXISTS caravanas (
    id                 INT AUTO_INCREMENT PRIMARY KEY,
    evento_id          INT NOT NULL,
    organizador_id     INT NOT NULL,
    vagas_totais       INT NOT NULL,
    preco              DECIMAL(10,2) NOT NULL,
    data_saida         DATETIME NOT NULL,
    local_saida        VARCHAR(200) NOT NULL,
    cidade_saida       VARCHAR(80) NOT NULL DEFAULT 'Marília',
    abertura_vendas_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    foto_url           VARCHAR(500) NULL,
    status             ENUM('aberta', 'lotada', 'cancelada', 'concluida') NOT NULL DEFAULT 'aberta',
    criado_em          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_caravana_evento FOREIGN KEY (evento_id) REFERENCES eventos(id),
    CONSTRAINT fk_caravana_organizador FOREIGN KEY (organizador_id) REFERENCES organizadores(conta_id)
) ENGINE=InnoDB;

ALTER TABLE caravanas ADD COLUMN IF NOT EXISTS cidade_saida VARCHAR(80) NOT NULL DEFAULT 'Marília';
ALTER TABLE caravanas ADD COLUMN IF NOT EXISTS abertura_vendas_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE caravanas ADD COLUMN IF NOT EXISTS foto_url VARCHAR(500) NULL;
ALTER TABLE caravanas ADD COLUMN IF NOT EXISTS status ENUM('aberta', 'lotada', 'cancelada', 'concluida') NOT NULL DEFAULT 'aberta';

-- ============================================================================
-- 9. reservas — passageiro (free OU premium) reservando vaga numa caravana
--    Exatamente um dos dois ids deve estar preenchido.
-- ============================================================================
CREATE TABLE IF NOT EXISTS reservas (
    id                    INT AUTO_INCREMENT PRIMARY KEY,
    caravana_id           INT NOT NULL,
    usuario_free_id       INT NULL,
    usuario_premium_id    INT NULL,
    status_pagamento      ENUM('pendente', 'pago', 'cancelado') NOT NULL DEFAULT 'pendente',
    cupom_id              INT NULL,
    desconto              DECIMAL(10,2) NOT NULL DEFAULT 0,
    valor_total           DECIMAL(10,2) NOT NULL DEFAULT 0,
    stripe_session_id     VARCHAR(255) NULL,
    stripe_payment_intent VARCHAR(255) NULL,
    expira_em             DATETIME NULL,
    criado_em             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_reserva_caravana FOREIGN KEY (caravana_id) REFERENCES caravanas(id),
    CONSTRAINT fk_reserva_free FOREIGN KEY (usuario_free_id) REFERENCES usuarios_free(conta_id),
    CONSTRAINT fk_reserva_premium FOREIGN KEY (usuario_premium_id) REFERENCES usuarios_premium(conta_id),
    CONSTRAINT chk_reserva_um_usuario CHECK (
        (usuario_free_id IS NOT NULL AND usuario_premium_id IS NULL) OR
        (usuario_free_id IS NULL AND usuario_premium_id IS NOT NULL)
    )
) ENGINE=InnoDB;

ALTER TABLE reservas ADD COLUMN IF NOT EXISTS cupom_id INT NULL;
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS desconto DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS valor_total DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS stripe_session_id VARCHAR(255) NULL;
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS stripe_payment_intent VARCHAR(255) NULL;
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS expira_em DATETIME NULL;

-- ============================================================================
-- 10. cupons — benefício exclusivo de assinantes Premium
-- ============================================================================
CREATE TABLE IF NOT EXISTS cupons (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    codigo              VARCHAR(40) NOT NULL UNIQUE,
    descricao           VARCHAR(255) NOT NULL,
    desconto_percentual DECIMAL(5,2) NOT NULL,
    caravana_id         INT NULL,
    usuario_premium_id  INT NOT NULL,
    usado               TINYINT(1) NOT NULL DEFAULT 0,
    validade            DATE NOT NULL,
    criado_em           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_cupom_caravana FOREIGN KEY (caravana_id) REFERENCES caravanas(id),
    CONSTRAINT fk_cupom_premium FOREIGN KEY (usuario_premium_id) REFERENCES usuarios_premium(conta_id)
) ENGINE=InnoDB;

-- ============================================================================
-- 11. brindes_premios_sorteios — benefícios físicos e sorteios entre passageiros
-- ============================================================================
CREATE TABLE IF NOT EXISTS brindes_premios_sorteios (
    id                      INT AUTO_INCREMENT PRIMARY KEY,
    tipo                    ENUM('brinde', 'premio', 'sorteio') NOT NULL,
    nome                    VARCHAR(150) NOT NULL,
    descricao               VARCHAR(255) NULL,
    caravana_id             INT NULL,
    data_sorteio            DATETIME NULL,
    ganhador_free_id        INT NULL,
    ganhador_premium_id     INT NULL,
    criado_em               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_brinde_caravana FOREIGN KEY (caravana_id) REFERENCES caravanas(id),
    CONSTRAINT fk_brinde_ganhador_free FOREIGN KEY (ganhador_free_id) REFERENCES usuarios_free(conta_id),
    CONSTRAINT fk_brinde_ganhador_premium FOREIGN KEY (ganhador_premium_id) REFERENCES usuarios_premium(conta_id),
    CONSTRAINT chk_brinde_ganhador_unico CHECK (
        ganhador_free_id IS NULL OR ganhador_premium_id IS NULL
    )
) ENGINE=InnoDB;

-- ============================================================================
-- 12. Seed inicial (idempotente com INSERT IGNORE)
--     Senha padrão dos usuários seed: "123456" (hash bcrypt)
-- ============================================================================
INSERT IGNORE INTO contas (id, nome, email, senha_hash, papel, time_torcida) VALUES
  (1, 'Admin Caravanas Hub', 'admin@caravanashub.com.br', '$2b$12$8K1p/a0dL1LXMIgoEDFrwOfMQ1jX7bG6bD2L3r1f5qW8J9yP6rK2e', 'admin', 'Palmeiras'),
  (2, 'Carlos Frota Alta Paulista', 'organizador@caravanashub.com.br', '$2b$12$8K1p/a0dL1LXMIgoEDFrwOfMQ1jX7bG6bD2L3r1f5qW8J9yP6rK2e', 'organizador', 'Corinthians');

INSERT IGNORE INTO organizadores (conta_id, documento, descricao_frota, contato_whatsapp) VALUES
  (1, '12.345.678/0001-90', 'Marcopolo Paradiso G7 1200 (44 lugares)', '(14) 99999-0001'),
  (2, '98.765.432/0001-10', 'Mercedes-Benz Sprinter 416 (15 lugares)', '(18) 99999-0002');

INSERT IGNORE INTO usuarios_premium (conta_id, ativo) VALUES (1, 1);

INSERT IGNORE INTO eventos (id, tipo, nome, local, pais, data_evento, criado_por, valor_ingresso) VALUES
  (1, 'futebol', 'Palmeiras x Corinthians', 'Allianz Parque - São Paulo', 'Brasil', '2026-12-06', 1, 180.00),
  (2, 'corrida', 'Grande Prêmio de São Paulo de F1', 'Autódromo de Interlagos - São Paulo', 'Brasil', '2027-11-07', 1, 990.00),
  (3, 'mma',     'UFC Fight Night São Paulo', 'Ginásio do Ibirapuera - São Paulo', 'Brasil', '2027-03-20', 2, 450.00),
  (4, 'futebol', 'São Paulo x Santos', 'MorumBIS - São Paulo', 'Brasil', '2027-02-14', 2, 120.00);

INSERT IGNORE INTO caravanas (id, evento_id, organizador_id, vagas_totais, preco, data_saida, local_saida, cidade_saida, abertura_vendas_em, status) VALUES
  (1, 1, 1, 44, 265.00, '2026-12-06 07:00:00', 'Terminal Rodoviário de Marília', 'Marília', '2026-11-10 10:00:00', 'aberta'),
  (2, 2, 1, 44, 1120.00, '2027-11-07 03:00:00', 'Praça da Bandeira - Tupã', 'Tupã', '2027-09-01 10:00:00', 'aberta'),
  (3, 3, 2, 15, 580.00, '2027-03-20 09:00:00', 'Posto Trevo - Rodovia SP-294', 'Adamantina', '2026-11-20 10:00:00', 'aberta'),
  (4, 4, 2, 15, 210.00, '2027-02-14 09:30:00', 'Estação Ferroviária de Garça', 'Garça', '2026-11-01 10:00:00', 'aberta');
