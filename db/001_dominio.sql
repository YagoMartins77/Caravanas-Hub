-- ============================================================================
-- 1. Remoção das tabelas do domínio antigo (filmes)
-- ============================================================================
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS comentarios;
DROP TABLE IF EXISTS favoritos;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================================
-- 2. contas — identidade única de login (Base para as outras tabelas)
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

-- ============================================================================
-- 3. admins — administradores da plataforma
-- ============================================================================
CREATE TABLE IF NOT EXISTS admins (
    conta_id        INT PRIMARY KEY,
    nivel           ENUM('super', 'moderador', 'suporte') NOT NULL DEFAULT 'moderador',
    setor           VARCHAR(100) NULL,
    desde           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_admin_conta FOREIGN KEY (conta_id) REFERENCES contas(id) ON DELETE CASCADE
) ENGINE=InnoDB;

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
-- 7. tipos_evento e eventos
-- ============================================================================
CREATE TABLE IF NOT EXISTS tipos_evento (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    nome            VARCHAR(60) NOT NULL UNIQUE,
    somente_admin   TINYINT(1) NOT NULL DEFAULT 0,
    criado_em       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO tipos_evento (id, nome, somente_admin) VALUES
    (1, 'futebol', 0),
    (2, 'corrida', 1),
    (3, 'mma',     0)
ON DUPLICATE KEY UPDATE nome=VALUES(nome), somente_admin=VALUES(somente_admin);

CREATE TABLE IF NOT EXISTS eventos (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    tipo_evento_id   INT NOT NULL,
    nome             VARCHAR(150) NOT NULL,
    local            VARCHAR(150) NOT NULL,
    pais             VARCHAR(80) NOT NULL DEFAULT 'Brasil',
    data_evento      DATE NOT NULL,
    competicao       VARCHAR(120) NULL,
    valor_ingresso   DECIMAL(10,2) NOT NULL DEFAULT 0,
    api_partida_id   INT NULL UNIQUE,
    escudo_mandante  VARCHAR(500) NULL,
    escudo_visitante VARCHAR(500) NULL,
    criado_por       INT NOT NULL,
    criado_em        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_evento_tipo FOREIGN KEY (tipo_evento_id) REFERENCES tipos_evento(id),
    CONSTRAINT fk_evento_criador FOREIGN KEY (criado_por) REFERENCES contas(id)
) ENGINE=InnoDB;

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

-- ============================================================================
-- 9. reservas — passageiro reservando vaga numa caravana
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
-- 11. brindes_premios_sorteios — benefícios físicos e sorteios
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
-- 12. reset_tokens — suporte a redefinição de senhas
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
-- 13. SEED INICIAL (Usuário Root e dados de demonstração)
-- ============================================================================
INSERT IGNORE INTO contas (id, nome, email, senha_hash, papel, time_torcida) VALUES
  (1, 'Administrador Root', 'root@caravanashub.com.br', '$2b$12$yGQCM76Kj4s3mTOroU8EE.Te3SMYO5P9wYCK7MqvwFC91Z/giyJ5O', 'admin', 'Santos'),
  (2, 'Carlos Frota Alta Paulista', 'organizador@caravanashub.com.br', '$2b$12$yGQCM76Kj4s3mTOroU8EE.Te3SMYO5P9wYCK7MqvwFC91Z/giyJ5O', 'organizador', 'Corinthians'),
  (3, 'Torcedor Exemplo', 'torcedor@email.com', '$2b$12$yGQCM76Kj4s3mTOroU8EE.Te3SMYO5P9wYCK7MqvwFC91Z/giyJ5O', 'passageiro', 'Santos');

UPDATE contas
   SET senha_hash = '$2b$12$yGQCM76Kj4s3mTOroU8EE.Te3SMYO5P9wYCK7MqvwFC91Z/giyJ5O'
 WHERE senha_hash = '$2b$12$KkQ1/TfF.33z6gV7L3zZ3O4t29pG9.CqQxZgB47v1/t78yYkL002e';

-- Vincula o admin à tabela admins
INSERT IGNORE INTO admins (conta_id, nivel, setor) VALUES (1, 'super', 'Administração Geral');

-- Vincula o organizador à tabela organizadores
INSERT IGNORE INTO organizadores (conta_id, documento, descricao_frota, contato_whatsapp) VALUES
  (1, '00.000.000/0001-00', 'Frota Oficial Caravana Hub (Ônibus & Vans)', '(14) 99999-0000'),
  (2, '12.345.678/0001-90', 'Marcopolo Paradiso G7 1200 (44 lugares)', '(14) 99999-0001');

-- Vincula usuários free e premium
INSERT IGNORE INTO usuarios_premium (conta_id, ativo) VALUES (1, 1);
INSERT IGNORE INTO usuarios_free (conta_id) VALUES (1), (2), (3);

-- Eventos de exemplo
INSERT IGNORE INTO eventos (id, tipo_evento_id, nome, local, pais, data_evento, competicao, valor_ingresso, escudo_mandante, escudo_visitante, criado_por) VALUES
  (1, 1, 'Santos x Palmeiras', 'Vila Belmiro - Santos', 'Brasil', '2026-12-06', 'Campeonato Brasileiro - Série A', 140.00, 'https://cdn.api-futebol.com.br/times/escudos/677fc82a860d4.svg', 'https://cdn.api-futebol.com.br/times/escudos/677fc746b0687.svg', 1),
  (2, 2, 'Grande Prêmio de São Paulo de F1', 'Autódromo de Interlagos - São Paulo', 'Brasil', '2027-11-07', 'Fórmula 1', 990.00, NULL, NULL, 1),
  (3, 3, 'UFC Fight Night São Paulo', 'Ginásio do Ibirapuera - São Paulo', 'Brasil', '2027-03-20', 'UFC', 450.00, NULL, NULL, 1),
  (4, 1, 'Corinthians x Santos', 'Neo Química Arena - São Paulo', 'Brasil', '2027-02-14', 'Campeonato Paulista', 120.00, 'https://cdn.api-futebol.com.br/times/escudos/677fc7386c4ef.svg', 'https://cdn.api-futebol.com.br/times/escudos/677fc82a860d4.svg', 2);

-- Caravanas de exemplo
INSERT IGNORE INTO caravanas (id, evento_id, organizador_id, vagas_totais, preco, data_saida, local_saida, cidade_saida, abertura_vendas_em, status) VALUES
  (1, 1, 1, 44, 280.00, '2026-12-06 06:00:00', 'Terminal Rodoviário de Marília', 'Marília', '2026-11-01 10:00:00', 'aberta'),
  (2, 2, 1, 44, 1120.00, '2027-11-07 03:00:00', 'Praça da Bandeira - Tupã', 'Tupã', '2027-09-01 10:00:00', 'aberta'),
  (3, 3, 2, 15, 580.00, '2027-03-20 09:00:00', 'Posto Trevo - Rodovia SP-294', 'Adamantina', '2026-11-20 10:00:00', 'aberta'),
  (4, 4, 2, 15, 230.00, '2027-02-14 08:30:00', 'Estação Ferroviária de Garça', 'Garça', '2026-11-01 10:00:00', 'aberta');
