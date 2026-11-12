use near_sdk::store::LookupMap;
use near_sdk::{near, IntoStorageKey};

/// Entries kept per worker. Older ones are overwritten.
pub const CAPACITY: u32 = 20;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Recorded income. `amount` is the income.
    Payment,
    /// Advance paid out. `amount` is the principal, `fee` its fee.
    Advance,
    /// Parts of one income collected towards the open advance.
    Repayment,
    /// Advance fully repaid. `amount` and `fee` are its totals.
    Closed,
    Late,
    /// `amount` is the principal that was lost.
    WrittenOff,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub kind: Kind,
    pub amount: u128,
    pub fee: u128,
    pub at: u64,
}

/// Ring buffer of the latest entries per worker, stored at
/// `(handle, sequence % CAPACITY)` so a worker's storage never grows past
/// `CAPACITY` entries.
#[near(serializers = [borsh])]
pub struct ActivityLog {
    entries: LookupMap<(String, u8), Entry>,
}

impl ActivityLog {
    pub fn new(prefix: impl IntoStorageKey) -> Self {
        Self {
            entries: LookupMap::new(prefix),
        }
    }

    /// Appends an entry as number `*count` and advances the count.
    pub fn push(&mut self, handle: &str, count: &mut u32, entry: Entry) {
        self.entries.insert(Self::key(handle, *count), entry);
        *count += 1;
    }

    /// Up to `limit` entries starting at sequence `from`, oldest first.
    /// Entries that already left the ring are skipped.
    pub fn page(&self, handle: &str, count: u32, from: u32, limit: u32) -> Vec<&Entry> {
        let start = from.max(count.saturating_sub(CAPACITY));
        let end = start.saturating_add(limit.min(CAPACITY)).min(count);
        (start..end)
            .filter_map(|sequence| self.entries.get(&Self::key(handle, sequence)))
            .collect()
    }

    fn key(handle: &str, sequence: u32) -> (String, u8) {
        (handle.to_string(), (sequence % CAPACITY) as u8)
    }
}
