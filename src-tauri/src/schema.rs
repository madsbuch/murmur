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
diesel::table! {
    file_blobs (network_id, sha256) {
        network_id -> Text,
        sha256 -> Text,
        size_bytes -> BigInt,
        content -> Binary,
    }
}

diesel::table! {
    settings (id) {
        id -> Integer,
        theme -> Text,
    }
}

diesel::joinable!(file_blobs -> networks (network_id));
diesel::table! {
    incoming_shares (id) {
        id -> Text,
        name -> Text,
        mime_type -> Text,
        content -> Binary,
        created_at -> BigInt,
    }
}
diesel::table! {
    share_receipts (id) {
        id -> Text,
    }
}
diesel::allow_tables_to_appear_in_same_query!(
    app_state,
    networks,
    recovery_drafts,
    file_blobs,
    settings,
    incoming_shares,
    share_receipts
);
