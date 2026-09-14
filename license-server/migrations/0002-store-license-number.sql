-- 관리자 화면에서 전체 라이선스 번호를 확인할 수 있도록 새 컬럼을 추가합니다.
-- 기존 레코드는 보안상 해시만 보관되어 있어 이 컬럼을 복원할 수 없습니다.
ALTER TABLE licenses ADD COLUMN key_value TEXT;
