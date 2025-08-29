# RNDR Node Monitor

<img width="2682" height="2013" alt="image" src="https://github.com/user-attachments/assets/6e2cd539-b720-48d9-a313-e8502f5557e2" />




A cross-platform monitoring tool for RNDR network nodes. This application provides real-time statistics, GPU health monitoring, and network-wide visibility for all connected render clients in a self-hosting dashboard.

## Features

  * **Real-Time Node Monitoring:** View live data for all RNDR nodes on your local network. The dashboard automatically discovers and adds new nodes.
  * **Detailed GPU Health:** Monitor critical GPU metrics including temperature, utilization, memory usage, performance state (P-State), and receive alerts for hardware thermal throttling events.
  * **Self-Hosting Web UI:** The application automatically elects a host on the network to serve a web-based version of the dashboard, accessible from any device on the network. If the host goes offline, another node takes over. You should use the web view if wanting to access stats  from a machine that is not using the rndr client.
  * **Comprehensive Statistics:** Track lifetime, daily, and current-epoch frame counts (successful vs. failed) for each node.
  * **On-Demand Epoch Reporting:** A built-in report generator scans the entire RNDR log file to identify all past work epochs. Users can select and generate detailed CSV reports showing timestamps and render times for every completed frame within a chosen epoch.
  * **Live Log Viewer:** See the last 25 log entries for any selected node, with live updates as new events occur.

## Support the Project

* **If you find this tool useful, please consider supporting its development. Donations are appreciated but not required. Enjoy.**

*    **BTC: bc1qpyzffgaw8rxyrk7knsgnh3rzvpzftgyw8emcsl**

*    **ETH: 0x4975117825a2987b0Da16b7cd117b1047866B430**

*    **SOL: D9qScoXoonvxK1tH8z3uLVpGgaYthfDVxPiUtPoC8XMg**


## Requirements

* **Operating System:** Windows 10 / 11 (64-bit)
* **Graphics Card:** An NVIDIA GPU is required for health and status monitoring, as the application utilizes `nvidia-smi`.
* **Rndr Client:** The rndrclient.exe must be ran on your system one time for the application to successfully run as it will parse the log file. Or you can create an empty log file at `C:\Users\yourusername\AppData\Local\OtoyRndrNetwork\rndr_log.txt`

## How to Use

1.  Go to the **[Releases](https://www.google.com/search?q=https://github.com/montezma/rndr-node-monitor/releases)** page of this repository.
2.  Download the latest portable `.exe` file from the "Assets" section.
3.  Run the application. No installation is required.
4.  To ensure the mDNS works, you must restart once. This will ensure the privleges approved for the firewall allow http://render.local:34568 to be reached.

    If you have issue be sure to report them here. I am not a full time developer, so there may be things I will not get to. Feel free to add suggestions or fork.


## Development

To run the project from source, you will need Node.js and npm installed.

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/montezma/rndr-node-monitor.git
    cd rndr-node-monitor
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Run the application in development mode:**

    ```bash
    npm start
    ```

4.  **Build a portable executable:**

    ```bash
    npm run build
    ```

    The packaged application will be located in the `dist` folder.

## License

This project is licensed under the MIT License.


## Disclaimer

This project is an unofficial, third-party tool developed by the community. It is not affiliated with, endorsed by, or connected to OTOY or the RNDR Network in any way. The data presented by this application is parsed from local log files and system commands and is provided for informational purposes only. The accuracy of the statistics is not guaranteed. Use this software at your own risk. I assume no liability for any issues, damages, or discrepancies that may arise from its use.
