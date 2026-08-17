use serde_json::json;
use trading_kernel::{score_route_batch_json, trading_kernel_backend};

#[test]
fn scores_depth_aware_batch_routes_like_scalar_ts_contract() {
    let request = r#"{
      "route": {
        "id": "xrp-usd-xrp",
        "edges": [
          {
            "from": "XRP",
            "to": "USD",
            "feeBps": 10,
            "levels": [
              { "price": 2, "sizeIn": 4 },
              { "price": 1.4, "sizeIn": 6 }
            ]
          },
          {
            "from": "USD",
            "to": "XRP",
            "feeBps": 10,
            "levels": [{ "price": 0.58, "sizeIn": 20 }]
          }
        ]
      },
      "amountsIn": [10, 5],
      "costs": {
        "fixedCostInStartAsset": 0.05,
        "latencyPenaltyBps": 5,
        "adverseSelectionBps": 10,
        "lvrBps": 5
      }
    }"#;

    let parsed: serde_json::Value =
        serde_json::from_str(&score_route_batch_json(request.to_string())).unwrap();
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["backend"], "native-rust");
    let results = parsed["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert!((results[0]["amountOut"].as_f64().unwrap() - 9.492985512).abs() < 1e-9);
    assert!((results[0]["netProfit"].as_f64().unwrap() - -0.577014488).abs() < 1e-9);
    assert_eq!(results[0]["isFireable"], false);
    assert!((results[1]["netProfit"].as_f64().unwrap() - 0.381101452).abs() < 1e-9);
    assert_eq!(results[1]["isFireable"], true);
}

#[test]
fn rejects_extreme_non_finite_or_malformed_payloads_without_panicking() {
    let cases = [
        "",
        "not-json",
        r#"{"route":{"edges":[]},"amountsIn":[1]}"#,
        r#"{"route":{"edges":[{"from":"A","to":"B","levels":[{"price":1,"sizeIn":1}]},{"from":"B","to":"A","levels":[{"price":1,"sizeIn":1}]}]},"amountsIn":["nan"]}"#,
        r#"{"route":{"edges":[{"from":"A","to":"B","levels":[{"price":1e309,"sizeIn":1}]},{"from":"B","to":"A","levels":[{"price":1,"sizeIn":1}]}]},"amountsIn":[1]}"#,
        r#"{"route":{"edges":[{"from":"A","to":"B","levels":[{"price":1,"sizeIn":-1}]},{"from":"B","to":"A","levels":[{"price":1,"sizeIn":1}]}]},"amountsIn":[1]}"#,
    ];

    for case in cases {
        let parsed: serde_json::Value =
            serde_json::from_str(&score_route_batch_json(case.to_string())).unwrap();
        assert_eq!(parsed["ok"], false, "case should fail closed: {case}");
        assert!(parsed["error"]["code"].as_str().unwrap().len() > 0);
    }
}

#[test]
fn returns_null_per_invalid_amount_while_scoring_valid_neighbors() {
    let request = r#"{
      "route": {
        "edges": [
          { "from": "A", "to": "B", "levels": [{ "price": 2, "sizeIn": 10 }] },
          { "from": "B", "to": "A", "levels": [{ "price": 0.6, "sizeIn": 20 }] }
        ]
      },
      "amountsIn": [1, 0, -1, 10]
    }"#;

    let parsed: serde_json::Value =
        serde_json::from_str(&score_route_batch_json(request.to_string())).unwrap();
    assert_eq!(parsed["ok"], true);
    let results = parsed["results"].as_array().unwrap();
    assert!(results[0].is_object());
    assert!(results[1].is_null());
    assert!(results[2].is_null());
    assert!(results[3].is_object());
}

#[test]
fn scores_large_batch_and_fails_closed_when_depth_exhausts() {
    let amounts: Vec<f64> = (1..=512).map(|i| i as f64 * 0.25).collect();
    let request = json!({
        "route": {
            "id": "large-batch-cycle",
            "edges": [
                {
                    "from": "A",
                    "to": "B",
                    "feeBps": 2,
                    "levels": [
                        { "price": 1.02, "sizeIn": 40 },
                        { "price": 1.01, "sizeIn": 40 }
                    ]
                },
                {
                    "from": "B",
                    "to": "C",
                    "feeBps": 3,
                    "levels": [{ "price": 1.01, "sizeIn": 90 }]
                },
                {
                    "from": "C",
                    "to": "A",
                    "feeBps": 4,
                    "levels": [{ "price": 1.005, "sizeIn": 100 }]
                }
            ]
        },
        "amountsIn": amounts,
        "costs": {
            "fixedCostInStartAsset": 0.001,
            "gasCostInStartAsset": 0.001,
            "latencyPenaltyBps": 1,
            "adverseSelectionBps": 1,
            "lvrBps": 1
        }
    });

    let parsed: serde_json::Value =
        serde_json::from_str(&score_route_batch_json(request.to_string())).unwrap();
    assert_eq!(parsed["ok"], true);
    let results = parsed["results"].as_array().unwrap();
    assert_eq!(results.len(), 512);
    assert!(results[0].is_object());
    assert!(results[320].is_null());
    assert!(results[511].is_null());

    let mut scored = 0;
    for result in results.iter().filter(|result| result.is_object()) {
        scored += 1;
        assert!(result["amountIn"].as_f64().unwrap().is_finite());
        assert!(result["amountOut"].as_f64().unwrap().is_finite());
        assert!(result["grossProfit"].as_f64().unwrap().is_finite());
        assert!(result["netProfit"].as_f64().unwrap().is_finite());
        assert!(result["netProfitPct"].as_f64().unwrap().is_finite());
        assert!(result["totalCostInStartAsset"]
            .as_f64()
            .unwrap()
            .is_finite());
    }
    assert!(scored > 250);
}

#[test]
fn identifies_native_backend() {
    assert_eq!(trading_kernel_backend(), "native-rust");
}
