diesel::table! {
    app_state (id) {
        id -> Integer,
        device_id -> Text,
        active_network_id -> Nullable<Text>,
    }
}

diesel::table! {
    networks (id) {
        id -> Text,
        name -> Text,
        protocol_version -> Integer,
        secret -> Binary,
        document -> Binary,
    }
}

diesel::table! {
    recovery_drafts (network_id) {
        network_id -> Text,
        note_id -> Text,
        title -> Text,
        body -> Text,
        base_heads -> Text,
    }
}

diesel::joinable!(app_state -> networks (active_network_id));
diesel::joinable!(recovery_drafts -> networks (network_id));
diesel::allow_tables_to_appear_in_same_query!(app_state, networks, recovery_drafts);
