SET client_encoding = 'UTF8';
-- ↑ PHẢI là dòng đầu tiên (psql trên Windows mặc định đọc file theo WIN1252)

-- ============================================================
-- 99_crawl_optional.sql — BẢNG CỦA HỆ THỐNG CÀO (TUỲ CHỌN)
-- ============================================================
-- Bạn nói không cần cào nữa vì data đã đủ → BÌNH THƯỜNG KHÔNG CẦN CHẠY FILE NÀY.
--
-- Chỉ chạy khi gặp một trong hai trường hợp:
--   1. Mở trang /dashboard bị lỗi 500 "relation catalog_crawl_... does not exist"
--   2. Sau này muốn bật lại đội worker cào bổ sung
--
-- Các bảng này tạo ra sẽ RỖNG và gần như không tốn dung lượng.
--   psql -U catalog_user -d catalog -f 99_crawl_optional.sql
-- ============================================================

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: catalog_crawl_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE catalog_crawl_jobs (
    id integer NOT NULL,
    make text NOT NULL,
    model_line text,
    status text DEFAULT 'pending'::text NOT NULL,
    claimed_by text,
    claimed_at timestamp with time zone,
    finished_at timestamp with time zone,
    parts_found integer DEFAULT 0,
    models_found integer DEFAULT 0,
    error text,
    attempts integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    coverage_score integer,
    missing_parts text,
    coverage_checked_at timestamp with time zone
);


--
-- Name: catalog_crawl_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE catalog_crawl_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: catalog_crawl_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE catalog_crawl_jobs_id_seq OWNED BY catalog_crawl_jobs.id;


--
-- Name: catalog_crawl_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE catalog_crawl_log (
    id integer NOT NULL,
    make text NOT NULL,
    model_code text NOT NULL,
    model_line text,
    scraped_at timestamp with time zone DEFAULT now(),
    parts_count integer DEFAULT 0,
    source text DEFAULT 'partsouq'::text
);


--
-- Name: catalog_crawl_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE catalog_crawl_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: catalog_crawl_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE catalog_crawl_log_id_seq OWNED BY catalog_crawl_log.id;


--
-- Name: catalog_crawl_unit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE catalog_crawl_unit_log (
    id integer NOT NULL,
    make text NOT NULL,
    model_code text NOT NULL,
    unit_key text NOT NULL,
    parts_count integer DEFAULT 0,
    scraped_at timestamp with time zone DEFAULT now(),
    source text DEFAULT 'partsouq'::text,
    worker_id text,
    parts_total integer DEFAULT 0,
    parts_new integer DEFAULT 0,
    fitments_new integer DEFAULT 0
);


--
-- Name: catalog_crawl_unit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE catalog_crawl_unit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: catalog_crawl_unit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE catalog_crawl_unit_log_id_seq OWNED BY catalog_crawl_unit_log.id;


--
-- Name: catalog_model_claim; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE catalog_model_claim (
    id integer NOT NULL,
    make text NOT NULL,
    model_key text NOT NULL,
    status text DEFAULT 'crawling'::text NOT NULL,
    claimed_by text,
    claimed_at timestamp with time zone DEFAULT now(),
    finished_at timestamp with time zone,
    units_total integer DEFAULT 0,
    units_done integer DEFAULT 0
);


--
-- Name: catalog_model_claim_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE catalog_model_claim_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: catalog_model_claim_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE catalog_model_claim_id_seq OWNED BY catalog_model_claim.id;


--
-- Name: catalog_unit_retry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE catalog_unit_retry (
    id integer NOT NULL,
    make text NOT NULL,
    model_key text NOT NULL,
    unit_key text NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    last_blocked_at timestamp with time zone DEFAULT now()
);


--
-- Name: catalog_unit_retry_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE catalog_unit_retry_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: catalog_unit_retry_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE catalog_unit_retry_id_seq OWNED BY catalog_unit_retry.id;


--
-- Name: catalog_worker_heartbeat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE catalog_worker_heartbeat (
    worker_id text NOT NULL,
    status text,
    current_job text,
    parts_hour integer DEFAULT 0,
    last_seen timestamp with time zone DEFAULT now(),
    command text DEFAULT 'continue'::text
);


--
-- Name: catalog_crawl_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_crawl_jobs ALTER COLUMN id SET DEFAULT nextval('catalog_crawl_jobs_id_seq'::regclass);


--
-- Name: catalog_crawl_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_crawl_log ALTER COLUMN id SET DEFAULT nextval('catalog_crawl_log_id_seq'::regclass);


--
-- Name: catalog_crawl_unit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_crawl_unit_log ALTER COLUMN id SET DEFAULT nextval('catalog_crawl_unit_log_id_seq'::regclass);


--
-- Name: catalog_model_claim id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_model_claim ALTER COLUMN id SET DEFAULT nextval('catalog_model_claim_id_seq'::regclass);


--
-- Name: catalog_unit_retry id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_unit_retry ALTER COLUMN id SET DEFAULT nextval('catalog_unit_retry_id_seq'::regclass);


--
-- Name: catalog_crawl_jobs catalog_crawl_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_crawl_jobs
    ADD CONSTRAINT catalog_crawl_jobs_pkey PRIMARY KEY (id);


--
-- Name: catalog_crawl_log catalog_crawl_log_make_model_code_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_crawl_log
    ADD CONSTRAINT catalog_crawl_log_make_model_code_source_key UNIQUE (make, model_code, source);


--
-- Name: catalog_crawl_log catalog_crawl_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_crawl_log
    ADD CONSTRAINT catalog_crawl_log_pkey PRIMARY KEY (id);


--
-- Name: catalog_crawl_unit_log catalog_crawl_unit_log_make_model_code_unit_key_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_crawl_unit_log
    ADD CONSTRAINT catalog_crawl_unit_log_make_model_code_unit_key_source_key UNIQUE (make, model_code, unit_key, source);


--
-- Name: catalog_crawl_unit_log catalog_crawl_unit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_crawl_unit_log
    ADD CONSTRAINT catalog_crawl_unit_log_pkey PRIMARY KEY (id);


--
-- Name: catalog_model_claim catalog_model_claim_make_model_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_model_claim
    ADD CONSTRAINT catalog_model_claim_make_model_key_key UNIQUE (make, model_key);


--
-- Name: catalog_model_claim catalog_model_claim_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_model_claim
    ADD CONSTRAINT catalog_model_claim_pkey PRIMARY KEY (id);


--
-- Name: catalog_unit_retry catalog_unit_retry_make_model_key_unit_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_unit_retry
    ADD CONSTRAINT catalog_unit_retry_make_model_key_unit_key_key UNIQUE (make, model_key, unit_key);


--
-- Name: catalog_unit_retry catalog_unit_retry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_unit_retry
    ADD CONSTRAINT catalog_unit_retry_pkey PRIMARY KEY (id);


--
-- Name: catalog_worker_heartbeat catalog_worker_heartbeat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY catalog_worker_heartbeat
    ADD CONSTRAINT catalog_worker_heartbeat_pkey PRIMARY KEY (worker_id);


--
-- Name: idx_crawl_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crawl_jobs_status ON catalog_crawl_jobs USING btree (status);


--
-- Name: idx_crawl_log_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crawl_log_model ON catalog_crawl_log USING btree (make, model_code);


--
-- Name: idx_model_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_claim ON catalog_model_claim USING btree (make, model_key, status);


--
-- Name: idx_model_claim_finished; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_claim_finished ON catalog_model_claim USING btree (finished_at);


--
-- Name: idx_unit_log; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unit_log ON catalog_crawl_unit_log USING btree (make, model_code, unit_key);


--
-- Name: idx_unit_log_scraped; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unit_log_scraped ON catalog_crawl_unit_log USING btree (scraped_at);


--
-- Name: idx_unit_log_worker; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unit_log_worker ON catalog_crawl_unit_log USING btree (worker_id, scraped_at);


--
-- Name: idx_unit_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_unit_retry ON catalog_unit_retry USING btree (make, model_key, unit_key);


--
-- Name: uq_crawl_jobs_make_line; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_crawl_jobs_make_line ON catalog_crawl_jobs USING btree (make, COALESCE(model_line, ''::text));


--
-- PostgreSQL database dump complete
--


