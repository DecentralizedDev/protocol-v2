use crate::math::constants::AMM_RESERVE_PRECISION;
use crate::math::lp::*;
use crate::state::user::PerpPosition;

mod calculate_get_proportion_u128 {
    use crate::math::helpers::get_proportion_u128;

    use super::*;

    pub fn get_proportion_u128_safe(
        value: u128,
        numerator: u128,
        denominator: u128,
    ) -> DriftResult<u128> {
        if numerator == 0 {
            return Ok(0);
        }

        let proportional_value = if numerator <= denominator {
            let ratio = denominator.safe_mul(10000)?.safe_div(numerator)?;
            value.safe_mul(10000)?.safe_div(ratio)?
        } else {
            value.safe_mul(numerator)?.safe_div(denominator)?
        };

        Ok(proportional_value)
    }

    #[test]
    fn test_safe() {
        let sqrt_k = AMM_RESERVE_PRECISION * 10_123;
        let max_reserve = sqrt_k * 14121 / 10000;
        let max_asks = max_reserve - sqrt_k;

        // let ans1 = get_proportion_u128_safe(max_asks, sqrt_k - sqrt_k / 100, sqrt_k).unwrap();
        // let ans2 = get_proportion_u128(max_asks, sqrt_k - sqrt_k / 100, sqrt_k).unwrap();
        // assert_eq!(ans1, ans2); //fails

        let ans1 = get_proportion_u128_safe(max_asks, sqrt_k / 2, sqrt_k).unwrap();
        let ans2 = get_proportion_u128(max_asks, sqrt_k / 2, sqrt_k).unwrap();
        assert_eq!(ans1, ans2);

        let ans1 = get_proportion_u128_safe(max_asks, AMM_RESERVE_PRECISION, sqrt_k).unwrap();
        let ans2 = get_proportion_u128(max_asks, AMM_RESERVE_PRECISION, sqrt_k).unwrap();
        assert_eq!(ans1, ans2);

        let ans1 = get_proportion_u128_safe(max_asks, 0, sqrt_k).unwrap();
        let ans2 = get_proportion_u128(max_asks, 0, sqrt_k).unwrap();
        assert_eq!(ans1, ans2);

        let ans1 = get_proportion_u128_safe(max_asks, 1325324, sqrt_k).unwrap();
        let ans2 = get_proportion_u128(max_asks, 1325324, sqrt_k).unwrap();
        assert_eq!(ans1, ans2);

        // let ans1 = get_proportion_u128(max_asks, sqrt_k, sqrt_k).unwrap();
        // assert_eq!(ans1, max_asks);
    }
}

mod calculate_lp_open_bids_asks {
    use super::*;

    #[test]
    fn test_simple_lp_bid_ask() {
        let position = PerpPosition {
            lp_shares: 100,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_reserve: 10,
            max_base_asset_reserve: 100,
            min_base_asset_reserve: 0,
            sqrt_k: 200,
            ..AMM::default_test()
        };
        let market = PerpMarket {
            amm,
            ..PerpMarket::default_test()
        };

        let (open_bids, open_asks) = calculate_lp_open_bids_asks(&position, &market).unwrap();

        assert_eq!(open_bids, 10 * 100 / 200);
        assert_eq!(open_asks, -90 * 100 / 200);
    }

    #[test]
    fn test_max_ask() {
        let position = PerpPosition {
            lp_shares: 100,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_reserve: 0,
            max_base_asset_reserve: 100,
            min_base_asset_reserve: 0,
            sqrt_k: 200,
            ..AMM::default_test()
        };
        let market = PerpMarket {
            amm,
            ..PerpMarket::default_test()
        };

        let (open_bids, open_asks) = calculate_lp_open_bids_asks(&position, &market).unwrap();

        assert_eq!(open_bids, 0); // wont go anymore short
        assert_eq!(open_asks, -100 * 100 / 200);
    }

    #[test]
    fn test_max_bid() {
        let position = PerpPosition {
            lp_shares: 100,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_reserve: 10,
            max_base_asset_reserve: 10,
            min_base_asset_reserve: 0,
            sqrt_k: 200,
            ..AMM::default_test()
        };
        let market = PerpMarket {
            amm,
            ..PerpMarket::default_test()
        };

        let (open_bids, open_asks) = calculate_lp_open_bids_asks(&position, &market).unwrap();

        assert_eq!(open_bids, 10 * 100 / 200);
        assert_eq!(open_asks, 0); // no more long
    }
}

mod calculate_settled_lp_base_quote {
    use crate::math::constants::BASE_PRECISION_U64;

    use super::*;

    #[test]
    fn test_long_settle() {
        let position = PerpPosition {
            lp_shares: 100 * BASE_PRECISION_U64,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_amount_per_lp: 10,
            quote_asset_amount_per_lp: -10,
            ..AMM::default_test()
        };

        let (baa, qaa) = calculate_settled_lp_base_quote(&amm, &position).unwrap();

        assert_eq!(baa, 10 * 100);
        assert_eq!(qaa, -10 * 100);
    }

    #[test]
    fn test_short_settle() {
        let position = PerpPosition {
            lp_shares: 100 * BASE_PRECISION_U64,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_amount_per_lp: -10,
            quote_asset_amount_per_lp: 10,
            ..AMM::default_test()
        };

        let (baa, qaa) = calculate_settled_lp_base_quote(&amm, &position).unwrap();

        assert_eq!(baa, -10 * 100);
        assert_eq!(qaa, 10 * 100);
    }
}

mod calculate_settle_lp_metrics {
    use crate::math::constants::BASE_PRECISION_U64;

    use super::*;

    #[test]
    fn test_long_settle() {
        let position = PerpPosition {
            lp_shares: 100 * BASE_PRECISION_U64,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_amount_per_lp: 10,
            quote_asset_amount_per_lp: -10,
            order_step_size: 1,
            ..AMM::default_test()
        };

        let lp_metrics = calculate_settle_lp_metrics(&amm, &position).unwrap();

        assert_eq!(lp_metrics.base_asset_amount, 10 * 100);
        assert_eq!(lp_metrics.quote_asset_amount, -10 * 100);
        assert_eq!(lp_metrics.remainder_base_asset_amount, 0);
    }

    #[test]
    fn test_all_remainder() {
        let position = PerpPosition {
            lp_shares: 100 * BASE_PRECISION_U64,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_amount_per_lp: 10,
            quote_asset_amount_per_lp: -10,
            order_step_size: 50 * 100,
            ..AMM::default_test()
        };

        let lp_metrics = calculate_settle_lp_metrics(&amm, &position).unwrap();

        assert_eq!(lp_metrics.base_asset_amount, 0);
        assert_eq!(lp_metrics.quote_asset_amount, -10 * 100);
        assert_eq!(lp_metrics.remainder_base_asset_amount, 10 * 100);
    }

    #[test]
    fn test_portion_remainder() {
        let position = PerpPosition {
            lp_shares: BASE_PRECISION_U64,
            ..PerpPosition::default()
        };

        let amm = AMM {
            base_asset_amount_per_lp: 10,
            quote_asset_amount_per_lp: -10,
            order_step_size: 3,
            ..AMM::default_test()
        };

        let lp_metrics = calculate_settle_lp_metrics(&amm, &position).unwrap();

        assert_eq!(lp_metrics.base_asset_amount, 9);
        assert_eq!(lp_metrics.quote_asset_amount, -10);
        assert_eq!(lp_metrics.remainder_base_asset_amount, 1);
    }
}

mod calculate_lp_shares_to_burn_for_risk_reduction {
    use crate::math::lp::calculate_lp_shares_to_burn_for_risk_reduction;
    use crate::state::perp_market::PerpMarket;
    use crate::state::user::User;
    use crate::test_utils::create_account_info;
    use crate::{PRICE_PRECISION_I64, QUOTE_PRECISION};
    use anchor_lang::prelude::AccountLoader;
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    fn test() {
        let user_str = String::from("n3Vf4++XOuwuqzjlmLoHfrMxu0bx1zK4CI3jhlcn84aSUBauaSLU4gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARHJpZnQgTGlxdWlkaXR5IFByb3ZpZGVyICAgICAgICAbACHcCQAAAAAAAAAAAAAAAAAAAAAAAACcpMgCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2ssqwBAAAAAATnHP3///+9awAIAAAAAKnr8AcAAAAAqufxBwAAAAAAAAAAAAAAAAAAAAAAAAAAuITI//////8AeTlTJwAAANxGF1tu/P//abUakBEAAACBFNL6BAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+hUCAAAAAAAAAAAAAAAAACC8EHuk9f//1uYrCQMAAAAAAAAACQAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANv7p2UAAAAAnKTIAgAAAAAAAAAAAAAAAAAAAAAAAAAAsprK//////8AAAAAAAAAAPeGAgAAAAAAAAAAAAAAAAAzkaIOAAAAAA8AAACIEwAAAQACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
        let mut decoded_bytes = base64::decode(user_str).unwrap();
        let user_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let user_account_info = create_account_info(&key, true, &mut lamports, user_bytes, &owner);

        let user_loader: AccountLoader<User> = AccountLoader::try_from(&user_account_info).unwrap();
        let mut user = user_loader.load_mut().unwrap();
        let position = &mut user.perp_positions[0];

        let perp_market_str = String::from("Ct8MLGv1N/cU6tVVkVpIHdjrXil5+Blo7M7no01SEzFkvCN2nSnel3KwISF8o/5okioZqvmQEJy52E6a0AS00gJa1vUpMUQZgG2jAAAAAAAAAAAAAAAAAAMAAAAAAAAAiKOiAAAAAAATRqMAAAAAAEr2u2UAAAAA3EYXW278/////////////2m1GpARAAAAAAAAAAAAAACRgrV0qi0BAAAAAAAAAAAAAAAAAAAAAABFREBhQ1YEAAAAAAAAAAAA9sh+SuuHBwAAAAAAAAAAACaTDwAAAAAAAAAAAAAAAADvHx32D0IEAAAAAAAAAAAA67nFJa5vBAAAAAAAAAAAAHMxOUELtwUAAAAAAAAAAACqHV4AAAAAAAAAAAAAAAAApw4iE86DBwAAAAAAAAAAAADzSoISXwAAAAAAAAAAAAAAHtBmbKP/////////////CreY1F8CAAAAAAAAAAAAAPZZghQfAAAAAAAAAAAAAAAAQGNSv8YBAAAAAAAAAAAAUdkndDAAAAAAAAAAAAAAAEEeAcSS/v/////////////0bAXnbQEAAAAAAAAAAAAAPuj0I3f+/////////////6felr+KAQAAAAAAAAAAAABX2/mMhMQCAAAAAAAAAAAALukbAAAAAAAu6RsAAAAAAC7pGwAAAAAAqPUJAAAAAADkPmeWogAAAAAAAAAAAAAAsD8vhpIAAAAAAAAAAAAAACibCEwQAAAAAAAAAAAAAAAr/d/xbQAAAAAAAAAAAAAAwY+XFgAAAAAAAAAAAAAAAMyF/KFFAAAAAAAAAAAAAAA9rLKsAQAAAAAAAAAAAAAAPayyrAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB+6JzGf04EAAAAAAAAAAAAtqLk+X6VBwAAAAAAAAAAAPDUDdGDVwQAAAAAAAAAAABeb5d+v4UHAAAAAAAAAAAAgG2jAAAAAAAAAAAAAAAAACJ6ogAAAAAAE0qkAAAAAAAaYqMAAAAAAIF1pAAAAAAArJmiDgAAAAAlBwAAAAAAAN5ukP7/////veq7ZQAAAAAQDgAAAAAAAADh9QUAAAAAZAAAAAAAAAAAZc0dAAAAAAAAAAAAAAAAiuqcc0QAAAA8R6NuAQAAAIyqSgkAAAAAt+27ZQAAAAATCAEAAAAAAPjJAAAAAAAASva7ZQAAAACUEQAAoIYBALQ2AADKCAAASQEAAH0AAAD0ATIAZMgEAQAAAAAEAAAAfRuiDQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhv4EJ8hQEAAAAAAAAAAAAAAAAAAAAAADFNQk9OSy1QRVJQICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG8VAwAAAAAA+x4AAAAAAACFAwAAAAAAACYCAADuAgAAqGEAAFDDAADECQAA3AUAAAAAAAAQJwAABwQAAA0GAAAEAAEAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
        let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
        let perp_market_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let perp_market_account_info =
            create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

        let perp_market_loader: AccountLoader<PerpMarket> =
            AccountLoader::try_from(&perp_market_account_info).unwrap();
        let perp_market = perp_market_loader.load_mut().unwrap();

        let oracle_price = 10 * PRICE_PRECISION_I64;
        let quote_oracle_price = PRICE_PRECISION_I64;

        let margin_shortage = 40 * QUOTE_PRECISION;

        let (lp_shares_to_burn, base_asset_amount) =
            calculate_lp_shares_to_burn_for_risk_reduction(
                position,
                &perp_market,
                oracle_price,
                quote_oracle_price,
                margin_shortage,
            )
            .unwrap();

        assert_eq!(lp_shares_to_burn, 168900000000);
        assert_eq!(base_asset_amount, 12400000000);

        let margin_shortage = 20 * QUOTE_PRECISION;

        let (lp_shares_to_burn, base_asset_amount) =
            calculate_lp_shares_to_burn_for_risk_reduction(
                position,
                &perp_market,
                oracle_price,
                quote_oracle_price,
                margin_shortage,
            )
            .unwrap();

        assert_eq!(lp_shares_to_burn, 16800000000);
        assert_eq!(base_asset_amount, 8000000000);

        let margin_shortage = 5 * QUOTE_PRECISION;

        let (lp_shares_to_burn, base_asset_amount) =
            calculate_lp_shares_to_burn_for_risk_reduction(
                position,
                &perp_market,
                oracle_price,
                quote_oracle_price,
                margin_shortage,
            )
            .unwrap();

        assert_eq!(lp_shares_to_burn, 16800000000);
        assert_eq!(base_asset_amount, 2000000000);

        // flip existing position the other direction
        position.base_asset_amount = -position.base_asset_amount;

        let margin_shortage = 40 * QUOTE_PRECISION;

        let (lp_shares_to_burn, base_asset_amount) =
            calculate_lp_shares_to_burn_for_risk_reduction(
                position,
                &perp_market,
                oracle_price,
                quote_oracle_price,
                margin_shortage,
            )
            .unwrap();

        assert_eq!(lp_shares_to_burn, 168900000000);
        assert_eq!(base_asset_amount, 12400000000);

        let margin_shortage = 20 * QUOTE_PRECISION;

        let (lp_shares_to_burn, base_asset_amount) =
            calculate_lp_shares_to_burn_for_risk_reduction(
                position,
                &perp_market,
                oracle_price,
                quote_oracle_price,
                margin_shortage,
            )
            .unwrap();

        assert_eq!(lp_shares_to_burn, 16800000000);
        assert_eq!(base_asset_amount, 8000000000);

        let margin_shortage = 5 * QUOTE_PRECISION;

        let (lp_shares_to_burn, base_asset_amount) =
            calculate_lp_shares_to_burn_for_risk_reduction(
                position,
                &perp_market,
                oracle_price,
                quote_oracle_price,
                margin_shortage,
            )
            .unwrap();

        assert_eq!(lp_shares_to_burn, 16800000000);
        assert_eq!(base_asset_amount, 2000000000);
    }
}
