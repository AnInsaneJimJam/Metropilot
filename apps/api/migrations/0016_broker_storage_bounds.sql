-- Protocol limits apply to compact UTF-8 JSON in BrokerStore's contract parser.
-- JSONB text adds separator spaces; allow storage overhead without changing wire limits.
alter table broker_operations drop constraint broker_operations_request_check;
alter table broker_operations add constraint broker_operations_request_check
  check (octet_length(request::text) <= 65536);
alter table broker_results drop constraint broker_results_response_check;
alter table broker_results add constraint broker_results_response_check
  check (octet_length(response::text) <= 131072);
